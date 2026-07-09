//! Tree-walking evaluator. The non-obvious mechanics:
//!
//! - **Dynamic scoping** (UCB semantics): a frame stack; lookup walks frames top-down then
//!   globals; `make` assigns the nearest existing binding, else a global; `local` binds in the
//!   current frame. It's what published Logo programs assume, and with no first-class functions
//!   in the dialect, lexical capture would buy nothing.
//! - **Control flow as signals**: `output`/`stop` (and errors) unwind via `Sig`; the enclosing
//!   procedure call catches them.
//! - **Tail calls are required, not an optimization** — the canonical Logo loop is tail recursion
//!   (`to spiral :n fd :n rt 92 spiral :n + 2 end`). A user-proc call in tail position (the last
//!   statement of a proc body, including through tail `if`/`ifelse`/`run` blocks) raises
//!   `Sig::Tail`, which the running `call_proc` loop catches to rebind its frame and continue —
//!   so tail recursion consumes neither Logo frames nor Rust/WASM stack. Non-tail depth is capped
//!   by `Limits::max_depth`.
//! - **Budget**: every expression evaluation ticks a deterministic step counter (no wall clock —
//!   the registry memoizes on `hash(params)` and assumes params → geometry is pure).
//! - **Lists as code**: running a source-literal list re-parses its original tokens (real spans),
//!   cached by token range; runtime-built lists synthesize tokens carrying the call site's span.

use std::collections::HashMap;
use std::rc::Rc;

use crate::geom::Stroke;
use crate::rng::Rng;

use super::builtins::B;
use super::lex::{Span, Tok, Token};
use super::parse::{self, Expr, ExprKind, Op, Program};
use super::turtle::{Turtle, TurtleErr};
use super::value::{display, Value};
use super::{Limits, LogoError};

pub enum Sig {
    Err(LogoError),
    Output(Value),
    Stop,
    /// Tail call to user proc `idx` with evaluated args — caught by the innermost `call_proc`.
    Tail(usize, Vec<Value>),
}

impl From<LogoError> for Sig {
    fn from(e: LogoError) -> Sig {
        Sig::Err(e)
    }
}

type R<T> = Result<T, Sig>;

struct Frame {
    /// `None` = declared `local` but not yet given a value.
    vars: HashMap<Rc<str>, Option<Value>>,
}

pub struct Interp {
    program: Rc<Program>,
    globals: HashMap<Rc<str>, Value>,
    frames: Vec<Frame>,
    turtle: Turtle,
    rng: Rng,
    limits: Limits,
    steps: u64,
    repcounts: Vec<u64>,
    templates: Vec<Value>,
    /// Parsed-as-code cache for source-literal lists, keyed by packed token range.
    code_cache: HashMap<u64, Rc<Vec<Expr>>>,
    /// Element parameter overrides (`param` reads these).
    args: HashMap<String, f64>,
}

/// The turtle's final pose, in element-local page space (y-down, like the strokes): position in
/// mm and compass heading in degrees (0 = up on screen). The editor draws a turtle marker there
/// so programs can be grown iteratively by appending to the end.
#[derive(Debug)]
pub struct Pose {
    pub x: f32,
    pub y: f32,
    pub heading: f32,
}

#[derive(Debug)]
pub struct RunResult {
    pub strokes: Vec<Stroke>,
    pub pose: Pose,
}

pub fn run(
    program: Program,
    args: HashMap<String, f64>,
    seed: u32,
    limits: Limits,
) -> Result<RunResult, LogoError> {
    let mut it = Interp {
        program: Rc::new(program),
        globals: HashMap::new(),
        frames: Vec::new(),
        turtle: Turtle::new(limits.max_points, limits.max_strokes),
        rng: Rng::new(seed),
        limits,
        steps: 0,
        repcounts: Vec::new(),
        templates: Vec::new(),
        code_cache: HashMap::new(),
        args,
    };
    let prog = it.program.clone();
    match it.exec_all(&prog.body, false) {
        Ok(()) => {}
        Err(Sig::Err(e)) => return Err(e),
        Err(Sig::Output(_)) | Err(Sig::Stop) | Err(Sig::Tail(..)) => {
            unreachable!("output/stop/tail are caught at the procedure boundary")
        }
    }
    // Final pose in page space: emission negates y, headings agree (0 = up, clockwise on screen).
    let pose = Pose {
        x: it.turtle.xcor() as f32,
        y: -it.turtle.ycor() as f32,
        heading: it.turtle.heading() as f32,
    };
    let strokes = it
        .turtle
        .into_strokes()
        .map_err(|e| turtle_err(e, Span::new(0, 0)))?;
    Ok(RunResult { strokes, pose })
}

fn turtle_err(e: TurtleErr, span: Span) -> LogoError {
    match e {
        TurtleErr::TooManyPoints(n) => LogoError::limit(&format!("too many points (over {})", n), span),
        TurtleErr::TooManyStrokes(n) => LogoError::limit(&format!("too many strokes (over {})", n), span),
    }
}

fn unconsumed(v: &Value, span: Span) -> Sig {
    Sig::Err(LogoError::runtime(&format!("you don't say what to do with {}", display(v)), span))
}

impl Interp {
    // ── statement/block execution ───────────────────────────────────────────────────────────────

    /// Run statements in command context: any statement that produces a value is an error. When
    /// `tail` is set, the last statement runs in tail position (procedure bodies).
    fn exec_all(&mut self, stmts: &[Expr], tail: bool) -> R<()> {
        for (i, s) in stmts.iter().enumerate() {
            let is_last = i + 1 == stmts.len();
            if let Some(v) = self.eval(s, tail && is_last)? {
                return Err(unconsumed(&v, s.span));
            }
        }
        Ok(())
    }

    /// Run statements in value context (`run`/`if`/`ifelse` blocks): the last statement's value —
    /// if any — is the block's value.
    fn run_value_block(&mut self, stmts: &[Expr], tail: bool) -> R<Option<Value>> {
        if stmts.is_empty() {
            return Ok(None);
        }
        for s in &stmts[..stmts.len() - 1] {
            if let Some(v) = self.eval(s, false)? {
                return Err(unconsumed(&v, s.span));
            }
        }
        self.eval(&stmts[stmts.len() - 1], tail)
    }

    // ── expression evaluation ───────────────────────────────────────────────────────────────────

    fn eval(&mut self, e: &Expr, tail: bool) -> R<Option<Value>> {
        self.steps += 1;
        if self.steps > self.limits.max_steps {
            return Err(LogoError::limit(&format!("too many steps (over {})", self.limits.max_steps), e.span).into());
        }
        match &e.kind {
            ExprKind::Num(n) => Ok(Some(Value::Num(*n))),
            ExprKind::Word(w) => Ok(Some(Value::Word(w.clone()))),
            ExprKind::Lit(v) => Ok(Some(v.clone())),
            ExprKind::Var(name) => Ok(Some(self.get_var(name, e.span)?)),
            ExprKind::Neg(x) => {
                let v = self.eval_val(x)?;
                let n = self.num(&v, "-", x.span)?;
                Ok(Some(Value::Num(-n)))
            }
            ExprKind::Infix { op, l, r } => {
                let lv = self.eval_val(l)?;
                let rv = self.eval_val(r)?;
                self.infix(*op, &lv, &rv, e.span).map(Some)
            }
            ExprKind::Call { b, name, args } => {
                if let Some(b) = b {
                    let mut vals = Vec::with_capacity(args.len());
                    for a in args {
                        vals.push(self.eval_val(a)?);
                    }
                    self.builtin(*b, name, vals, e.span, tail)
                } else {
                    let idx = *self.program.proc_index.get(name).expect("parser resolved user procs");
                    let mut vals = Vec::with_capacity(args.len());
                    for a in args {
                        vals.push(self.eval_val(a)?);
                    }
                    if tail && !self.frames.is_empty() {
                        return Err(Sig::Tail(idx, vals));
                    }
                    self.call_proc(idx, vals, e.span)
                }
            }
        }
    }

    /// Evaluate in value position: the expression must produce a value.
    fn eval_val(&mut self, e: &Expr) -> R<Value> {
        match self.eval(e, false)? {
            Some(v) => Ok(v),
            None => {
                let what = match &e.kind {
                    ExprKind::Call { name, .. } => format!("{} didn't output a value", name),
                    _ => "expected a value here".to_string(),
                };
                Err(LogoError::runtime(&what, e.span).into())
            }
        }
    }

    fn infix(&mut self, op: Op, l: &Value, r: &Value, span: Span) -> R<Value> {
        match op {
            Op::Eq => return Ok(Value::Bool(l.logo_eq(r))),
            Op::Ne => return Ok(Value::Bool(!l.logo_eq(r))),
            _ => {}
        }
        let a = self.num(l, op_name(op), span)?;
        let b = self.num(r, op_name(op), span)?;
        Ok(match op {
            Op::Add => Value::Num(a + b),
            Op::Sub => Value::Num(a - b),
            Op::Mul => Value::Num(a * b),
            Op::Div => {
                if b == 0.0 {
                    return Err(LogoError::runtime("division by zero", span).into());
                }
                Value::Num(a / b)
            }
            Op::Lt => Value::Bool(a < b),
            Op::Gt => Value::Bool(a > b),
            Op::Le => Value::Bool(a <= b),
            Op::Ge => Value::Bool(a >= b),
            Op::Eq | Op::Ne => unreachable!(),
        })
    }

    // ── procedure calls ─────────────────────────────────────────────────────────────────────────

    fn call_proc(&mut self, mut idx: usize, mut vals: Vec<Value>, span: Span) -> R<Option<Value>> {
        if self.frames.len() >= self.limits.max_depth {
            return Err(LogoError::limit(
                &format!("too deep — over {} nested calls (tail recursion doesn't count; is a recursive call missing its stop condition?)", self.limits.max_depth),
                span,
            )
            .into());
        }
        let prog = self.program.clone();
        self.frames.push(bind_frame(&prog.procs[idx].params, vals));
        loop {
            let body = &prog.procs[idx].body;
            match self.exec_all(body, true) {
                Ok(()) => {
                    self.frames.pop();
                    return Ok(None);
                }
                Err(Sig::Tail(nidx, nvals)) => {
                    idx = nidx;
                    vals = nvals;
                    let frame = self.frames.last_mut().expect("in a call");
                    frame.vars.clear();
                    for (p, v) in prog.procs[idx].params.iter().zip(vals.drain(..)) {
                        frame.vars.insert(p.clone(), Some(v));
                    }
                }
                Err(Sig::Output(v)) => {
                    self.frames.pop();
                    return Ok(Some(v));
                }
                Err(Sig::Stop) => {
                    self.frames.pop();
                    return Ok(None);
                }
                Err(e) => {
                    self.frames.pop();
                    return Err(e);
                }
            }
        }
    }

    // ── variables ───────────────────────────────────────────────────────────────────────────────

    fn get_var(&self, name: &str, span: Span) -> R<Value> {
        for f in self.frames.iter().rev() {
            if let Some(slot) = f.vars.get(name) {
                return match slot {
                    Some(v) => Ok(v.clone()),
                    None => Err(LogoError::runtime(&format!("{} has no value", name), span).into()),
                };
            }
        }
        match self.globals.get(name) {
            Some(v) => Ok(v.clone()),
            None => Err(LogoError::runtime(&format!("{} has no value", name), span).into()),
        }
    }

    fn set_var(&mut self, name: &str, v: Value) {
        for f in self.frames.iter_mut().rev() {
            if let Some(slot) = f.vars.get_mut(name) {
                *slot = Some(v);
                return;
            }
        }
        self.globals.insert(Rc::from(name), v);
    }

    // ── lists as code ───────────────────────────────────────────────────────────────────────────

    /// The parsed instructions of a list value. Source literals parse out of the original token
    /// stream (cached by range, real spans); runtime-built lists synthesize tokens at `span`.
    fn block_body(&mut self, v: &Value, span: Span) -> R<Rc<Vec<Expr>>> {
        let l = match v {
            Value::List(l) => l,
            _ => return Err(LogoError::runtime(&format!("expected a list, got {}", display(v)), span).into()),
        };
        if let Some(packed) = l.lit {
            if let Some(hit) = self.code_cache.get(&packed) {
                return Ok(hit.clone());
            }
            let range = parse::unpack_range(packed);
            let body = parse::parse_range(&self.program.tokens, range, &self.program.arities).map_err(Sig::Err)?;
            let rc = Rc::new(body);
            self.code_cache.insert(packed, rc.clone());
            Ok(rc)
        } else {
            let toks = synth_tokens(&l.items, span);
            let body = parse::parse_range(&toks, (0, toks.len()), &self.program.arities).map_err(Sig::Err)?;
            Ok(Rc::new(body))
        }
    }

    // ── helpers ─────────────────────────────────────────────────────────────────────────────────

    fn num(&self, v: &Value, who: &str, span: Span) -> R<f64> {
        v.as_num()
            .ok_or_else(|| LogoError::runtime(&format!("{} doesn't like {} as input", who, display(v)), span).into())
    }

    fn boolean(&self, v: &Value, who: &str, span: Span) -> R<bool> {
        v.as_bool()
            .ok_or_else(|| LogoError::runtime(&format!("{} needs true or false, got {}", who, display(v)), span).into())
    }

    fn word(&self, v: &Value, who: &str, span: Span) -> R<Rc<str>> {
        v.as_word()
            .ok_or_else(|| LogoError::runtime(&format!("{} doesn't like {} as input", who, display(v)), span).into())
    }

    /// A two-number position list `[x y]`.
    fn pos_list(&self, v: &Value, who: &str, span: Span) -> R<(f64, f64)> {
        if let Value::List(l) = v {
            if l.items.len() == 2 {
                if let (Some(x), Some(y)) = (l.items[0].as_num(), l.items[1].as_num()) {
                    return Ok((x, y));
                }
            }
        }
        Err(LogoError::runtime(&format!("{} needs a position list [x y], got {}", who, display(v)), span).into())
    }

    fn tt(&mut self, r: Result<(), TurtleErr>, span: Span) -> R<()> {
        r.map_err(|e| Sig::Err(turtle_err(e, span)))
    }

    // ── builtin dispatch ────────────────────────────────────────────────────────────────────────

    fn builtin(&mut self, b: B, name: &str, mut args: Vec<Value>, span: Span, tail: bool) -> R<Option<Value>> {
        use Value::*;
        let val = |v: Value| Ok(Some(v));
        let none: R<Option<Value>> = Ok(None);
        match b {
            // ── turtle ──────────────────────────────────────────────────────────────────────────
            B::Forward | B::Back => {
                let d = self.num(&args[0], name, span)?;
                let d = if matches!(b, B::Back) { -d } else { d };
                let r = self.turtle.forward(d);
                self.tt(r, span)?;
                none
            }
            B::Right | B::Left => {
                let d = self.num(&args[0], name, span)?;
                self.turtle.turn(if matches!(b, B::Left) { -d } else { d });
                none
            }
            B::PenUp => {
                let r = self.turtle.pen_up();
                self.tt(r, span)?;
                none
            }
            B::PenDown => {
                self.turtle.pen_down();
                none
            }
            B::Home => {
                let r = self.turtle.home();
                self.tt(r, span)?;
                none
            }
            B::SetXY => {
                let x = self.num(&args[0], name, span)?;
                let y = self.num(&args[1], name, span)?;
                let r = self.turtle.line_to(x, y);
                self.tt(r, span)?;
                none
            }
            B::SetPos => {
                let (x, y) = self.pos_list(&args[0], name, span)?;
                let r = self.turtle.line_to(x, y);
                self.tt(r, span)?;
                none
            }
            B::SetX => {
                let x = self.num(&args[0], name, span)?;
                let y = self.turtle.ycor();
                let r = self.turtle.line_to(x, y);
                self.tt(r, span)?;
                none
            }
            B::SetY => {
                let y = self.num(&args[0], name, span)?;
                let x = self.turtle.xcor();
                let r = self.turtle.line_to(x, y);
                self.tt(r, span)?;
                none
            }
            B::SetHeading => {
                let d = self.num(&args[0], name, span)?;
                self.turtle.set_heading(d);
                none
            }
            B::Arc => {
                let deg = self.num(&args[0], name, span)?;
                let radius = self.num(&args[1], name, span)?;
                let r = self.turtle.arc(deg, radius);
                self.tt(r, span)?;
                none
            }
            B::Arc2 => {
                let deg = self.num(&args[0], name, span)?;
                let radius = self.num(&args[1], name, span)?;
                let r = self.turtle.arc2(deg, radius);
                self.tt(r, span)?;
                none
            }
            B::XCor => val(Num(self.turtle.xcor())),
            B::YCor => val(Num(self.turtle.ycor())),
            B::Heading => val(Num(self.turtle.heading())),
            B::Towards => {
                let (x, y) = self.pos_list(&args[0], name, span)?;
                val(Num(self.turtle.towards(x, y)))
            }
            B::Pos => val(Value::list(vec![Num(self.turtle.xcor()), Num(self.turtle.ycor())])),
            // ── pen ─────────────────────────────────────────────────────────────────────────────
            B::SetPressure => {
                let p = self.num(&args[0], name, span)?;
                self.turtle.set_pressure(p);
                none
            }
            B::Pressure => val(Num(self.turtle.pressure())),
            B::SetPen => {
                let n = self.num(&args[0], name, span)?;
                if !(0.0..=255.0).contains(&n) {
                    return Err(LogoError::runtime(&format!("there is no pen {}", display(&args[0])), span).into());
                }
                let r = self.turtle.set_pen(n as u16);
                self.tt(r, span)?;
                none
            }
            B::Pen => val(Num(self.turtle.pen() as f64)),
            // ── control ─────────────────────────────────────────────────────────────────────────
            B::Repeat => {
                let n = self.num(&args[0], name, span)?.floor();
                let body = self.block_body(&args[1], span)?;
                self.repcounts.push(0);
                let mut i = 0.0;
                let result = loop {
                    if i >= n {
                        break Ok(());
                    }
                    i += 1.0;
                    *self.repcounts.last_mut().unwrap() = i as u64;
                    if let Err(e) = self.exec_all(&body, false) {
                        break Err(e);
                    }
                };
                self.repcounts.pop();
                result?;
                none
            }
            B::RepCount => match self.repcounts.last() {
                Some(&c) => val(Num(c as f64)),
                None => Err(LogoError::runtime("repcount can only be used inside repeat", span).into()),
            },
            B::If => {
                let c = self.boolean(&args[0], name, span)?;
                if c {
                    let body = self.block_body(&args[1], span)?;
                    self.run_value_block(&body, tail)
                } else {
                    none
                }
            }
            B::IfElse => {
                let c = self.boolean(&args[0], name, span)?;
                let body = self.block_body(&args[if c { 1 } else { 2 }], span)?;
                self.run_value_block(&body, tail)
            }
            B::Run => {
                let body = self.block_body(&args[0], span)?;
                self.run_value_block(&body, tail)
            }
            B::While => {
                let cond = self.block_body(&args[0], span)?;
                let body = self.block_body(&args[1], span)?;
                loop {
                    let cv = match self.run_value_block(&cond, false)? {
                        Some(v) => v,
                        None => return Err(LogoError::runtime("the while condition didn't output a value", span).into()),
                    };
                    if !self.boolean(&cv, name, span)? {
                        break;
                    }
                    self.exec_all(&body, false)?;
                }
                none
            }
            B::For => {
                let (var, nums) = self.for_control(&args[0], span)?;
                let body = self.block_body(&args[1], span)?;
                let (start, limit) = (nums[0], nums[1]);
                let step = nums.get(2).copied().unwrap_or(if start <= limit { 1.0 } else { -1.0 });
                if step == 0.0 {
                    return Err(LogoError::runtime("for needs a nonzero step", span).into());
                }
                // The loop variable binds like `make` (nearest scope), restored afterwards.
                let prev = self.peek_var(&var);
                let mut v = start;
                let result = loop {
                    if (step > 0.0 && v > limit) || (step < 0.0 && v < limit) {
                        break Ok(());
                    }
                    self.set_var(&var, Num(v));
                    if let Err(e) = self.exec_all(&body, false) {
                        break Err(e);
                    }
                    v += step;
                };
                match prev {
                    Some(old) => self.set_var(&var, old),
                    None => {
                        self.globals.remove(&*var);
                    }
                }
                result?;
                none
            }
            B::Foreach => {
                let items = self.template_items(&args[0], name, span)?;
                let body = self.block_body(&args[1], span)?;
                for item in items {
                    self.templates.push(item);
                    let r = self.exec_all(&body, false);
                    self.templates.pop();
                    r?;
                }
                none
            }
            B::Map => {
                let body = self.block_body(&args[0], span)?;
                let was_word = !matches!(&args[1], List(_));
                let items = self.template_items(&args[1], name, span)?;
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    self.templates.push(item);
                    let r = self.run_value_block(&body, false);
                    self.templates.pop();
                    match r? {
                        Some(v) => out.push(v),
                        None => return Err(LogoError::runtime("the map template didn't output a value", span).into()),
                    }
                }
                if was_word {
                    let mut w = String::new();
                    for v in &out {
                        w.push_str(&self.word(v, name, span)?);
                    }
                    val(Word(Rc::from(w.as_str())))
                } else {
                    val(Value::list(out))
                }
            }
            B::Filter => {
                let body = self.block_body(&args[0], span)?;
                let was_word = !matches!(&args[1], List(_));
                let items = self.template_items(&args[1], name, span)?;
                let mut out = Vec::new();
                for item in items {
                    self.templates.push(item.clone());
                    let r = self.run_value_block(&body, false);
                    self.templates.pop();
                    match r? {
                        Some(v) => {
                            if self.boolean(&v, name, span)? {
                                out.push(item);
                            }
                        }
                        None => return Err(LogoError::runtime("the filter template didn't output a value", span).into()),
                    }
                }
                if was_word {
                    let mut w = String::new();
                    for v in &out {
                        w.push_str(&self.word(v, name, span)?);
                    }
                    val(Word(Rc::from(w.as_str())))
                } else {
                    val(Value::list(out))
                }
            }
            B::Output => {
                if self.frames.is_empty() {
                    return Err(LogoError::runtime("output can only be used inside a procedure", span).into());
                }
                Err(Sig::Output(args.pop().unwrap()))
            }
            B::Stop => {
                if self.frames.is_empty() {
                    return Err(LogoError::runtime("stop can only be used inside a procedure", span).into());
                }
                Err(Sig::Stop)
            }
            B::Question => match self.templates.last() {
                Some(v) => val(v.clone()),
                None => Err(LogoError::runtime("? can only be used inside map / filter / foreach templates", span).into()),
            },
            // ── variables ───────────────────────────────────────────────────────────────────────
            B::Make => {
                let n = self.word(&args[0], name, span)?.to_ascii_lowercase();
                let v = args.pop().unwrap();
                self.set_var(&n, v);
                none
            }
            B::Local => {
                if self.frames.is_empty() {
                    return Err(LogoError::runtime("local can only be used inside a procedure", span).into());
                }
                let names: Vec<Rc<str>> = match &args[0] {
                    List(l) => {
                        let mut ns = Vec::with_capacity(l.items.len());
                        for it in &l.items {
                            ns.push(Rc::from(self.word(it, name, span)?.to_ascii_lowercase().as_str()));
                        }
                        ns
                    }
                    v => vec![Rc::from(self.word(v, name, span)?.to_ascii_lowercase().as_str())],
                };
                let frame = self.frames.last_mut().unwrap();
                for n in names {
                    frame.vars.entry(n).or_insert(None);
                }
                none
            }
            B::LocalMake => {
                if self.frames.is_empty() {
                    return Err(LogoError::runtime("localmake can only be used inside a procedure", span).into());
                }
                let n: Rc<str> = Rc::from(self.word(&args[0], name, span)?.to_ascii_lowercase().as_str());
                let v = args.pop().unwrap();
                self.frames.last_mut().unwrap().vars.insert(n, Some(v));
                none
            }
            B::Thing => {
                let n = self.word(&args[0], name, span)?.to_ascii_lowercase();
                val(self.get_var(&n, span)?)
            }
            B::Param => {
                let n = self.word(&args[0], name, span)?.to_ascii_lowercase();
                // Optional range list: [min max] or [min max step].
                let range = if args.len() > 2 {
                    let items: Vec<f64> = match &args[2] {
                        List(l) if (2..=3).contains(&l.items.len()) => {
                            let mut nums = Vec::with_capacity(l.items.len());
                            for it in &l.items {
                                nums.push(self.num(it, name, span)?);
                            }
                            nums
                        }
                        v => {
                            return Err(LogoError::runtime(
                                &format!("param's range must be [min max] or [min max step], got {}", display(v)),
                                span,
                            )
                            .into())
                        }
                    };
                    let (lo, hi) = (items[0].min(items[1]), items[0].max(items[1]));
                    let step = items.get(2).copied().filter(|&s| s > 0.0);
                    Some((lo, hi, step))
                } else {
                    None
                };
                let v = match self.args.get(n.as_str()) {
                    Some(&over) if over.is_finite() => {
                        let snapped = match range {
                            Some((lo, hi, step)) => {
                                // Snap to the step grid anchored at min, then clamp.
                                let s = match step {
                                    Some(s) => lo + ((over - lo) / s).round() * s,
                                    None => over,
                                };
                                s.clamp(lo, hi)
                            }
                            None => over,
                        };
                        Num(snapped)
                    }
                    _ => args[1].clone(),
                };
                self.globals.insert(Rc::from(n.as_str()), v);
                none
            }
            // ── math ────────────────────────────────────────────────────────────────────────────
            B::Sum => self.fold_num(name, &args, span, |a, b| a + b),
            B::Product => self.fold_num(name, &args, span, |a, b| a * b),
            B::Min => self.fold_num(name, &args, span, f64::min),
            B::Max => self.fold_num(name, &args, span, f64::max),
            B::Difference => {
                let a = self.num(&args[0], name, span)?;
                let b = self.num(&args[1], name, span)?;
                val(Num(a - b))
            }
            B::Quotient => {
                let a = self.num(&args[0], name, span)?;
                let b = self.num(&args[1], name, span)?;
                if b == 0.0 {
                    return Err(LogoError::runtime("division by zero", span).into());
                }
                val(Num(a / b))
            }
            B::Remainder => {
                let a = self.num(&args[0], name, span)?;
                let b = self.num(&args[1], name, span)?;
                if b == 0.0 {
                    return Err(LogoError::runtime("division by zero", span).into());
                }
                val(Num(a % b))
            }
            B::Modulo => {
                let a = self.num(&args[0], name, span)?;
                let b = self.num(&args[1], name, span)?;
                if b == 0.0 {
                    return Err(LogoError::runtime("division by zero", span).into());
                }
                val(Num(((a % b) + b) % b))
            }
            B::MinusFn => {
                let a = self.num(&args[0], name, span)?;
                val(Num(-a))
            }
            B::Abs => self.math1(name, &args, span, f64::abs),
            B::Int => self.math1(name, &args, span, f64::trunc),
            B::Round => self.math1(name, &args, span, f64::round),
            B::Sqrt => self.math1(name, &args, span, f64::sqrt),
            B::Exp => self.math1(name, &args, span, f64::exp),
            B::Ln => self.math1(name, &args, span, f64::ln),
            B::Log10 => self.math1(name, &args, span, f64::log10),
            B::Sin => self.math1(name, &args, span, |a| a.to_radians().sin()),
            B::Cos => self.math1(name, &args, span, |a| a.to_radians().cos()),
            B::Tan => self.math1(name, &args, span, |a| a.to_radians().tan()),
            B::Arctan => self.math1(name, &args, span, |a| a.atan().to_degrees()),
            B::Power => {
                let a = self.num(&args[0], name, span)?;
                let b = self.num(&args[1], name, span)?;
                let r = a.powf(b);
                if !r.is_finite() {
                    return Err(LogoError::runtime(&format!("power {} {} isn't a number", a, b), span).into());
                }
                val(Num(r))
            }
            B::Pi => val(Num(std::f64::consts::PI)),
            // ── logic ───────────────────────────────────────────────────────────────────────────
            B::And => {
                let mut r = true;
                for a in &args {
                    r = r && self.boolean(a, name, span)?;
                }
                val(Bool(r))
            }
            B::Or => {
                let mut r = false;
                for a in &args {
                    r = r || self.boolean(a, name, span)?;
                }
                val(Bool(r))
            }
            B::Not => {
                let b = self.boolean(&args[0], name, span)?;
                val(Bool(!b))
            }
            B::True => val(Bool(true)),
            B::False => val(Bool(false)),
            // ── words & lists ───────────────────────────────────────────────────────────────────
            B::Word => {
                let mut w = String::new();
                for a in &args {
                    w.push_str(&self.word(a, name, span)?);
                }
                val(Word(Rc::from(w.as_str())))
            }
            B::List => val(Value::list(args)),
            B::Sentence => {
                let mut out = Vec::new();
                for a in args {
                    match a {
                        List(l) => out.extend(l.items.iter().cloned()),
                        v => out.push(v),
                    }
                }
                val(Value::list(out))
            }
            B::FPut | B::LPut => {
                let item = args[0].clone();
                match &args[1] {
                    List(l) => {
                        let mut items = Vec::with_capacity(l.items.len() + 1);
                        if matches!(b, B::FPut) {
                            items.push(item);
                            items.extend(l.items.iter().cloned());
                        } else {
                            items.extend(l.items.iter().cloned());
                            items.push(item);
                        }
                        val(Value::list(items))
                    }
                    v => Err(LogoError::runtime(&format!("{} needs a list, got {}", name, display(v)), span).into()),
                }
            }
            B::First | B::Last => {
                let first = matches!(b, B::First);
                match &args[0] {
                    List(l) => match if first { l.items.first() } else { l.items.last() } {
                        Some(v) => val(v.clone()),
                        None => Err(LogoError::runtime(&format!("{} doesn't like an empty list", name), span).into()),
                    },
                    v => {
                        let w = self.word(v, name, span)?;
                        match if first { w.chars().next() } else { w.chars().last() } {
                            Some(c) => val(Word(Rc::from(c.to_string().as_str()))),
                            None => Err(LogoError::runtime(&format!("{} doesn't like an empty word", name), span).into()),
                        }
                    }
                }
            }
            B::ButFirst | B::ButLast => {
                let butfirst = matches!(b, B::ButFirst);
                match &args[0] {
                    List(l) => {
                        if l.items.is_empty() {
                            return Err(LogoError::runtime(&format!("{} doesn't like an empty list", name), span).into());
                        }
                        let items = if butfirst { l.items[1..].to_vec() } else { l.items[..l.items.len() - 1].to_vec() };
                        val(Value::list(items))
                    }
                    v => {
                        let w = self.word(v, name, span)?;
                        if w.is_empty() {
                            return Err(LogoError::runtime(&format!("{} doesn't like an empty word", name), span).into());
                        }
                        let s: String = if butfirst {
                            w.chars().skip(1).collect()
                        } else {
                            let n = w.chars().count();
                            w.chars().take(n - 1).collect()
                        };
                        val(Word(Rc::from(s.as_str())))
                    }
                }
            }
            B::Item => {
                let n = self.num(&args[0], name, span)?;
                let i = n as i64;
                if i < 1 {
                    return Err(LogoError::runtime(&format!("item {} is out of range", display(&args[0])), span).into());
                }
                let i = (i - 1) as usize;
                match &args[1] {
                    List(l) => match l.items.get(i) {
                        Some(v) => val(v.clone()),
                        None => Err(LogoError::runtime(&format!("item {} is out of range", i + 1), span).into()),
                    },
                    v => {
                        let w = self.word(v, name, span)?;
                        match w.chars().nth(i) {
                            Some(c) => val(Word(Rc::from(c.to_string().as_str()))),
                            None => Err(LogoError::runtime(&format!("item {} is out of range", i + 1), span).into()),
                        }
                    }
                }
            }
            B::Count => match &args[0] {
                List(l) => val(Num(l.items.len() as f64)),
                v => {
                    let w = self.word(v, name, span)?;
                    val(Num(w.chars().count() as f64))
                }
            },
            B::EmptyP => match &args[0] {
                List(l) => val(Bool(l.items.is_empty())),
                Word(w) => val(Bool(w.is_empty())),
                _ => val(Bool(false)),
            },
            B::ListP => val(Bool(matches!(&args[0], List(_)))),
            B::NumberP => val(Bool(!matches!(&args[0], List(_) | Bool(_)) && args[0].as_num().is_some())),
            B::WordP => val(Bool(matches!(&args[0], Word(_) | Num(_)))),
            B::MemberP => match &args[1] {
                List(l) => val(Bool(l.items.iter().any(|it| it.logo_eq(&args[0])))),
                v => {
                    let hay = self.word(v, name, span)?.to_ascii_lowercase();
                    let needle = self.word(&args[0], name, span)?.to_ascii_lowercase();
                    val(Bool(hay.contains(needle.as_str())))
                }
            },
            B::Reverse => match &args[0] {
                List(l) => {
                    let mut items = l.items.clone();
                    items.reverse();
                    val(Value::list(items))
                }
                v => {
                    let w = self.word(v, name, span)?;
                    let s: String = w.chars().rev().collect();
                    val(Word(Rc::from(s.as_str())))
                }
            },
            // ── random ──────────────────────────────────────────────────────────────────────────
            B::Random => {
                let n = self.num(&args[0], name, span)?.floor();
                if n < 1.0 || n > u32::MAX as f64 {
                    return Err(LogoError::runtime(&format!("random doesn't like {} as input", display(&args[0])), span).into());
                }
                val(Num((self.rng.next() % n as u32) as f64))
            }
            B::Pick => match &args[0] {
                List(l) if !l.items.is_empty() => {
                    let i = self.rng.next() as usize % l.items.len();
                    val(l.items[i].clone())
                }
                v => {
                    let w = self.word(v, name, span)?;
                    let n = w.chars().count();
                    if n == 0 {
                        return Err(LogoError::runtime("pick doesn't like an empty input", span).into());
                    }
                    let i = self.rng.next() as usize % n;
                    val(Word(Rc::from(w.chars().nth(i).unwrap().to_string().as_str())))
                }
            },
            B::ReRandom => {
                let n = self.num(&args[0], name, span)?.abs();
                self.rng = Rng::new(n as u32);
                none
            }
            // ── io: accepted, ignored (no console surface) ──────────────────────────────────────
            B::Print | B::Show => none,
        }
    }

    fn math1(&mut self, name: &str, args: &[Value], span: Span, f: impl Fn(f64) -> f64) -> R<Option<Value>> {
        let a = self.num(&args[0], name, span)?;
        let r = f(a);
        if !r.is_finite() {
            return Err(LogoError::runtime(&format!("{} {} isn't a number", name, display(&args[0])), span).into());
        }
        Ok(Some(Value::Num(r)))
    }

    fn fold_num(&mut self, name: &str, args: &[Value], span: Span, f: impl Fn(f64, f64) -> f64) -> R<Option<Value>> {
        let mut acc = self.num(&args[0], name, span)?;
        for a in &args[1..] {
            acc = f(acc, self.num(a, name, span)?);
        }
        Ok(Some(Value::Num(acc)))
    }

    /// Current binding of `name` if any (for save/restore around `for`).
    fn peek_var(&self, name: &str) -> Option<Value> {
        for f in self.frames.iter().rev() {
            if let Some(slot) = f.vars.get(name) {
                return slot.clone();
            }
        }
        self.globals.get(name).cloned()
    }

    /// `for`'s control list `[i start end step?]`: the variable name plus 2–3 evaluated numbers.
    /// Source-literal lists support full expressions (`for [i 1 :n * 2]`); runtime-built lists
    /// fall back to plain numbers.
    fn for_control(&mut self, v: &Value, span: Span) -> R<(Rc<str>, Vec<f64>)> {
        let l = match v {
            Value::List(l) => l,
            _ => return Err(LogoError::runtime(&format!("for needs a control list, got {}", display(v)), span).into()),
        };
        if let Some(packed) = l.lit {
            let (start, end) = parse::unpack_range(packed);
            if start >= end {
                return Err(LogoError::runtime("for needs a control list like [i 1 10]", span).into());
            }
            let var: Rc<str> = match &self.program.tokens[start].tok {
                Tok::Ident(n) => Rc::from(n.as_str()),
                Tok::Word(n) => Rc::from(n.to_ascii_lowercase().as_str()),
                _ => return Err(LogoError::runtime("the first item of for's control list must be the variable name", self.program.tokens[start].span).into()),
            };
            let exprs = parse::parse_range(&self.program.tokens, (start + 1, end), &self.program.arities).map_err(Sig::Err)?;
            if exprs.len() < 2 || exprs.len() > 3 {
                return Err(LogoError::runtime("for's control list needs [name start end] or [name start end step]", span).into());
            }
            let mut nums = Vec::with_capacity(exprs.len());
            for e in &exprs {
                let v = self.eval_val(e)?;
                nums.push(self.num(&v, "for", e.span)?);
            }
            Ok((var, nums))
        } else {
            if l.items.len() < 3 || l.items.len() > 4 {
                return Err(LogoError::runtime("for's control list needs [name start end] or [name start end step]", span).into());
            }
            let var = self.word(&l.items[0], "for", span)?.to_ascii_lowercase();
            let mut nums = Vec::new();
            for it in &l.items[1..] {
                nums.push(self.num(it, "for", span)?);
            }
            Ok((Rc::from(var.as_str()), nums))
        }
    }

    /// The items a template iterates: list items, or a word's characters.
    fn template_items(&mut self, v: &Value, who: &str, span: Span) -> R<Vec<Value>> {
        match v {
            Value::List(l) => Ok(l.items.clone()),
            v => {
                let w = self.word(v, who, span)?;
                Ok(w.chars().map(|c| Value::Word(Rc::from(c.to_string().as_str()))).collect())
            }
        }
    }
}

fn bind_frame(params: &[Rc<str>], vals: Vec<Value>) -> Frame {
    let mut vars = HashMap::with_capacity(params.len());
    for (p, v) in params.iter().zip(vals) {
        vars.insert(p.clone(), Some(v));
    }
    Frame { vars }
}

fn op_name(op: Op) -> &'static str {
    match op {
        Op::Add => "+",
        Op::Sub => "-",
        Op::Mul => "*",
        Op::Div => "/",
        Op::Eq => "=",
        Op::Lt => "<",
        Op::Gt => ">",
        Op::Le => "<=",
        Op::Ge => ">=",
        Op::Ne => "<>",
    }
}

/// Synthesize a token stream from a runtime-built list so it can run as code. Every token carries
/// the call site's span (the list has no source of its own). Words map to identifiers (`:x` to a
/// variable), operator words to operators, nested lists to literal tokens.
fn synth_tokens(items: &[Value], span: Span) -> Vec<Token> {
    let mut toks = Vec::with_capacity(items.len());
    for v in items {
        let tok = match v {
            Value::Num(n) => Tok::Num(*n),
            Value::Bool(b) => Tok::Ident(if *b { "true".into() } else { "false".into() }),
            Value::List(_) => Tok::Lit(v.clone()),
            Value::Word(w) => match w.as_ref() {
                "+" => Tok::Plus,
                "-" => Tok::Minus { unary: false },
                "*" => Tok::Star,
                "/" => Tok::Slash,
                "=" => Tok::Eq,
                "<" => Tok::Lt,
                ">" => Tok::Gt,
                "<=" => Tok::Le,
                ">=" => Tok::Ge,
                "<>" => Tok::Ne,
                "(" => Tok::LParen,
                ")" => Tok::RParen,
                _ => {
                    if let Some(name) = w.strip_prefix(':') {
                        Tok::Var(name.to_ascii_lowercase())
                    } else {
                        Tok::Ident(w.to_ascii_lowercase())
                    }
                }
            },
        };
        toks.push(Token { tok, span, line: 0 });
    }
    toks
}
