//! Two-pass Logo parser. Classic Logo parses *greedily by arity* — `fd 10 rt 90` works because
//! `fd` is known to take one input — so user-procedure arities must be known before bodies parse:
//!
//!   - **Pass 1** scans the token stream (at bracket depth 0) for `to NAME :a :b … end` headers,
//!     recording each procedure's name, parameters, and body token range.
//!   - **Pass 2** parses every body and the top-level statements with the combined arity table
//!     (builtins from `builtins.rs` + pass-1 procedures).
//!
//! List literals `[…]` are **data**: nothing inside is arity-parsed here. Each literal keeps its
//! token range so `run`/`repeat`-as-code can re-parse the original tokens lazily (with real
//! spans), cached by range in the evaluator. Expressions mix prefix calls with infix arithmetic:
//! comparison < additive < multiplicative < unary, and `(sum 1 2 3)` is the explicit-arity form.

use std::collections::HashMap;
use std::rc::Rc;

use super::builtins::{self, B};
use super::lex::{Span, Tok, Token};
use super::value::{ListVal, Value};
use super::LogoError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Add,
    Sub,
    Mul,
    Div,
    Eq,
    Lt,
    Gt,
    Le,
    Ge,
    Ne,
}

pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

pub enum ExprKind {
    Num(f64),
    /// `"quoted` word.
    Word(Rc<str>),
    /// `:variable` reference (lowercased).
    Var(Rc<str>),
    /// A literal value: a `[…]` list (carrying its token range for as-code parsing) or a
    /// synthesized literal from a runtime list.
    Lit(Value),
    /// Builtin (`b` set) or user-procedure call.
    Call {
        b: Option<B>,
        name: Rc<str>,
        args: Vec<Expr>,
    },
    Infix {
        op: Op,
        l: Box<Expr>,
        r: Box<Expr>,
    },
    Neg(Box<Expr>),
}

pub struct ProcDef {
    pub name: Rc<str>,
    pub params: Vec<Rc<str>>,
    pub body: Vec<Expr>,
    pub name_span: Span,
}

pub struct Program {
    /// The full original token stream — list literals re-parse out of it at runtime.
    pub tokens: Vec<Token>,
    pub body: Vec<Expr>,
    pub procs: Vec<ProcDef>,
    /// User-procedure name → index into `procs`.
    pub proc_index: HashMap<Rc<str>, usize>,
    /// User-procedure name → arity, for runtime list-as-code parsing.
    pub arities: HashMap<Rc<str>, u8>,
}

/// A pass-1 procedure header: params + the token range of the body.
struct Header {
    name: Rc<str>,
    params: Vec<Rc<str>>,
    name_span: Span,
    body: (usize, usize),
}

pub fn parse_program(tokens: Vec<Token>) -> Result<Program, LogoError> {
    // ── pass 1: find to…end procedures at bracket depth 0 ───────────────────────────────────────
    let mut headers: Vec<Header> = Vec::new();
    let mut top_ranges: Vec<(usize, usize)> = Vec::new();
    let mut proc_index: HashMap<Rc<str>, usize> = HashMap::new();
    {
        let mut depth = 0i32;
        let mut i = 0usize;
        let mut top_start = 0usize;
        while i < tokens.len() {
            match &tokens[i].tok {
                Tok::LBracket => {
                    depth += 1;
                    i += 1;
                }
                Tok::RBracket => {
                    depth -= 1;
                    i += 1;
                }
                Tok::Ident(id) if depth == 0 && id == "end" => {
                    return Err(LogoError::parse("end without to", tokens[i].span));
                }
                Tok::Ident(id) if depth == 0 && id == "to" => {
                    top_ranges.push((top_start, i));
                    let to_line = tokens[i].line;
                    i += 1;
                    let (name, name_span) = match tokens.get(i) {
                        Some(Token { tok: Tok::Ident(n), span, line }) if *line == to_line => {
                            (Rc::<str>::from(n.as_str()), *span)
                        }
                        _ => return Err(LogoError::parse("to needs a procedure name on the same line", tokens[i - 1].span)),
                    };
                    if builtins::lookup(&name).is_some() {
                        return Err(LogoError::parse(&format!("{} is a built-in and can't be redefined", name), name_span));
                    }
                    if proc_index.contains_key(&name) {
                        return Err(LogoError::parse(&format!("{} is already defined", name), name_span));
                    }
                    i += 1;
                    // Parameters: :vars on the header line.
                    let mut params = Vec::new();
                    while let Some(Token { tok: Tok::Var(v), line, .. }) = tokens.get(i) {
                        if *line != to_line {
                            break;
                        }
                        params.push(Rc::<str>::from(v.as_str()));
                        i += 1;
                    }
                    // Body: everything until the matching depth-0 `end`.
                    let body_start = i;
                    let mut d = 0i32;
                    loop {
                        match tokens.get(i).map(|t| &t.tok) {
                            Some(Tok::LBracket) => d += 1,
                            Some(Tok::RBracket) => d -= 1,
                            Some(Tok::Ident(id)) if d == 0 && id == "to" => {
                                return Err(LogoError::parse("to inside a procedure — did you forget end?", tokens[i].span));
                            }
                            Some(Tok::Ident(id)) if d == 0 && id == "end" => break,
                            None => {
                                return Err(LogoError::parse(&format!("to {} has no end", name), name_span));
                            }
                            _ => {}
                        }
                        i += 1;
                    }
                    proc_index.insert(name.clone(), headers.len());
                    headers.push(Header { name, params, name_span, body: (body_start, i) });
                    i += 1; // past `end`
                    top_start = i;
                }
                _ => {
                    i += 1;
                }
            }
        }
        if depth != 0 {
            // Let pass 2 report the precise unmatched bracket; scan order there gives a good span.
        }
        top_ranges.push((top_start, tokens.len()));
    }

    let arities: HashMap<Rc<str>, u8> = headers.iter().map(|h| (h.name.clone(), h.params.len() as u8)).collect();

    // ── pass 2: parse bodies with the full arity table ──────────────────────────────────────────
    let mut body = Vec::new();
    for &(a, b) in &top_ranges {
        let mut p = Parser { toks: &tokens, pos: a, end: b, arities: &arities };
        body.extend(p.parse_stmts()?);
    }
    let mut procs = Vec::with_capacity(headers.len());
    for h in headers {
        let mut p = Parser { toks: &tokens, pos: h.body.0, end: h.body.1, arities: &arities };
        let pbody = p.parse_stmts()?;
        procs.push(ProcDef { name: h.name, params: h.params, body: pbody, name_span: h.name_span });
    }

    Ok(Program { tokens, body, procs, proc_index, arities })
}

/// Parse a slice of an existing token stream as instructions — used both by pass 2 above and by
/// the evaluator to run a list literal as code (`arities` comes from the same `Program`).
pub fn parse_range(
    tokens: &[Token],
    range: (usize, usize),
    arities: &HashMap<Rc<str>, u8>,
) -> Result<Vec<Expr>, LogoError> {
    let mut p = Parser { toks: tokens, pos: range.0, end: range.1, arities };
    p.parse_stmts()
}

pub struct Parser<'a> {
    pub toks: &'a [Token],
    pub pos: usize,
    pub end: usize,
    pub arities: &'a HashMap<Rc<str>, u8>,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<&'a Token> {
        if self.pos < self.end {
            Some(&self.toks[self.pos])
        } else {
            None
        }
    }

    fn end_span(&self) -> Span {
        // Point at the last token in range (or a zero span for an empty range).
        if self.pos > 0 && self.pos - 1 < self.toks.len() {
            self.toks[self.pos - 1].span
        } else {
            Span::new(0, 0)
        }
    }

    pub fn parse_stmts(&mut self) -> Result<Vec<Expr>, LogoError> {
        let mut out = Vec::new();
        while self.pos < self.end {
            match &self.toks[self.pos].tok {
                Tok::RBracket => return Err(LogoError::parse("] without [", self.toks[self.pos].span)),
                Tok::RParen => return Err(LogoError::parse(") without (", self.toks[self.pos].span)),
                _ => out.push(self.parse_expr()?),
            }
        }
        Ok(out)
    }

    pub fn parse_expr(&mut self) -> Result<Expr, LogoError> {
        let l = self.parse_additive()?;
        // Comparisons: left-associative, lowest precedence.
        let mut node = l;
        loop {
            let op = match self.peek().map(|t| &t.tok) {
                Some(Tok::Eq) => Op::Eq,
                Some(Tok::Lt) => Op::Lt,
                Some(Tok::Gt) => Op::Gt,
                Some(Tok::Le) => Op::Le,
                Some(Tok::Ge) => Op::Ge,
                Some(Tok::Ne) => Op::Ne,
                _ => break,
            };
            self.pos += 1;
            let r = self.parse_additive()?;
            let span = Span::merge(node.span, r.span);
            node = Expr { kind: ExprKind::Infix { op, l: Box::new(node), r: Box::new(r) }, span };
        }
        Ok(node)
    }

    fn parse_additive(&mut self) -> Result<Expr, LogoError> {
        let mut node = self.parse_multiplicative()?;
        loop {
            let op = match self.peek().map(|t| &t.tok) {
                Some(Tok::Plus) => Op::Add,
                // A unary-hinted minus starts the NEXT operand (e.g. `fd 10 -5`), never subtraction.
                Some(Tok::Minus { unary: false }) => Op::Sub,
                _ => break,
            };
            self.pos += 1;
            let r = self.parse_multiplicative()?;
            let span = Span::merge(node.span, r.span);
            node = Expr { kind: ExprKind::Infix { op, l: Box::new(node), r: Box::new(r) }, span };
        }
        Ok(node)
    }

    fn parse_multiplicative(&mut self) -> Result<Expr, LogoError> {
        let mut node = self.parse_unary()?;
        loop {
            let op = match self.peek().map(|t| &t.tok) {
                Some(Tok::Star) => Op::Mul,
                Some(Tok::Slash) => Op::Div,
                _ => break,
            };
            self.pos += 1;
            let r = self.parse_unary()?;
            let span = Span::merge(node.span, r.span);
            node = Expr { kind: ExprKind::Infix { op, l: Box::new(node), r: Box::new(r) }, span };
        }
        Ok(node)
    }

    fn parse_unary(&mut self) -> Result<Expr, LogoError> {
        if let Some(Token { tok: Tok::Minus { .. }, span, .. }) = self.peek() {
            // In operand position any minus negates (`3 - -2`, `fd -10`).
            let start = *span;
            self.pos += 1;
            let operand = self.parse_unary()?;
            let span = Span::merge(start, operand.span);
            return Ok(Expr { kind: ExprKind::Neg(Box::new(operand)), span });
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, LogoError> {
        let tok = match self.peek() {
            Some(t) => t,
            None => return Err(LogoError::parse("expected a value here", self.end_span())),
        };
        let span = tok.span;
        match &tok.tok {
            Tok::Num(n) => {
                self.pos += 1;
                Ok(Expr { kind: ExprKind::Num(*n), span })
            }
            Tok::Word(w) => {
                self.pos += 1;
                Ok(Expr { kind: ExprKind::Word(Rc::from(w.as_str())), span })
            }
            Tok::Var(v) => {
                self.pos += 1;
                Ok(Expr { kind: ExprKind::Var(Rc::from(v.as_str())), span })
            }
            Tok::Lit(v) => {
                self.pos += 1;
                Ok(Expr { kind: ExprKind::Lit(v.clone()), span })
            }
            Tok::LBracket => self.parse_list_literal(),
            Tok::LParen => self.parse_paren(),
            Tok::Ident(name) => {
                let name = name.clone();
                self.pos += 1;
                self.parse_call(&name, span, None)
            }
            Tok::RBracket => Err(LogoError::parse("] without [", span)),
            Tok::RParen => Err(LogoError::parse(") without (", span)),
            Tok::Plus | Tok::Star | Tok::Slash | Tok::Eq | Tok::Lt | Tok::Gt | Tok::Le | Tok::Ge | Tok::Ne => {
                Err(LogoError::parse("expected a value before this operator", span))
            }
            Tok::Minus { .. } => unreachable!("minus handled by parse_unary"),
        }
    }

    /// A call to `name` (already consumed, at `name_span`). `explicit` = Some(arg count) when
    /// inside a `( name … )` form — the args are pre-parsed by the caller.
    fn parse_call(&mut self, name: &str, name_span: Span, explicit: Option<Vec<Expr>>) -> Result<Expr, LogoError> {
        let (b, arity, vararg) = if let Some(def) = builtins::lookup(name) {
            if matches!(def.id, B::True) {
                return Ok(Expr { kind: ExprKind::Lit(Value::Bool(true)), span: name_span });
            }
            if matches!(def.id, B::False) {
                return Ok(Expr { kind: ExprKind::Lit(Value::Bool(false)), span: name_span });
            }
            (Some(def.id), def.arity as usize, def.vararg)
        } else if let Some(&a) = self.arities.get(name) {
            (None, a as usize, false)
        } else if name == "to" || name == "end" {
            return Err(LogoError::parse(&format!("{} can only appear at the top level", name), name_span));
        } else {
            return Err(LogoError::parse(&format!("I don't know how to {}", name), name_span));
        };

        let args = match explicit {
            Some(args) => {
                if vararg {
                    if args.is_empty() {
                        return Err(LogoError::parse(&format!("{} needs at least one input", name), name_span));
                    }
                } else if args.len() != arity {
                    return Err(LogoError::parse(
                        &format!("{} takes {} input{}, not {}", name, arity, if arity == 1 { "" } else { "s" }, args.len()),
                        name_span,
                    ));
                }
                args
            }
            None => {
                let mut args = Vec::with_capacity(arity);
                for _ in 0..arity {
                    if self.peek().is_none() {
                        return Err(LogoError::parse(&format!("not enough inputs to {}", name), name_span));
                    }
                    args.push(self.parse_expr()?);
                }
                // `param "size 40 [10 80]` — the range list is an optional trailing input. A bare
                // list can never legally start a statement, so the greedy grab is unambiguous.
                if matches!(b, Some(B::Param)) {
                    if let Some(Token { tok: Tok::LBracket, .. }) = self.peek() {
                        args.push(self.parse_list_literal()?);
                    }
                }
                args
            }
        };

        let span = args.last().map_or(name_span, |a| Span::merge(name_span, a.span));
        Ok(Expr { kind: ExprKind::Call { b, name: Rc::from(name), args }, span })
    }

    /// `( … )`: either the explicit-arity call form `(sum 1 2 3)` or a grouped expression.
    fn parse_paren(&mut self) -> Result<Expr, LogoError> {
        let open = self.toks[self.pos].span;
        self.pos += 1;
        // `( ident … )` where ident is a known callee → explicit-arity call.
        if let Some(Token { tok: Tok::Ident(name), span, .. }) = self.peek() {
            let callable = builtins::lookup(name).is_some() || self.arities.contains_key(name.as_str());
            if callable {
                let name = name.clone();
                let name_span = *span;
                self.pos += 1;
                let mut args = Vec::new();
                loop {
                    match self.peek() {
                        None => return Err(LogoError::parse("( without )", open)),
                        Some(Token { tok: Tok::RParen, .. }) => {
                            self.pos += 1;
                            break;
                        }
                        Some(_) => args.push(self.parse_expr()?),
                    }
                }
                return self.parse_call(&name, name_span, Some(args));
            }
        }
        let inner = self.parse_expr()?;
        match self.peek() {
            Some(Token { tok: Tok::RParen, .. }) => {
                self.pos += 1;
                Ok(inner)
            }
            Some(t) => Err(LogoError::parse("expected )", t.span)),
            None => Err(LogoError::parse("( without )", open)),
        }
    }

    /// `[ … ]` as **data**, keeping the content's token range for as-code re-parsing.
    fn parse_list_literal(&mut self) -> Result<Expr, LogoError> {
        let open = self.toks[self.pos].span;
        self.pos += 1;
        let value = self.parse_list_items(open)?;
        let close = self.toks[self.pos - 1].span; // parse_list_items consumed the `]`
        Ok(Expr { kind: ExprKind::Lit(value), span: Span::merge(open, close) })
    }

    /// Collect items until the matching `]` (consumed). Returns the list value; its `lit` range
    /// covers the content tokens (exclusive of brackets).
    fn parse_list_items(&mut self, open: Span) -> Result<Value, LogoError> {
        let content_start = self.pos;
        let mut items = Vec::new();
        loop {
            let tok = match self.peek() {
                Some(t) => t,
                None => return Err(LogoError::parse("[ without ]", open)),
            };
            match &tok.tok {
                Tok::RBracket => {
                    let content_end = self.pos;
                    self.pos += 1;
                    let lv = ListVal { items, lit: Some(pack_range(content_start, content_end)) };
                    return Ok(Value::List(Rc::new(lv)));
                }
                Tok::LBracket => {
                    let inner_open = tok.span;
                    self.pos += 1;
                    let v = self.parse_list_items(inner_open)?;
                    items.push(v);
                }
                Tok::Num(n) => {
                    items.push(Value::Num(*n));
                    self.pos += 1;
                }
                // Inside a literal list everything else is a data word.
                Tok::Word(w) => {
                    items.push(Value::Word(Rc::from(w.as_str())));
                    self.pos += 1;
                }
                Tok::Ident(w) => {
                    items.push(Value::Word(Rc::from(w.as_str())));
                    self.pos += 1;
                }
                Tok::Var(v) => {
                    items.push(Value::Word(Rc::from(format!(":{}", v).as_str())));
                    self.pos += 1;
                }
                Tok::Minus { unary: true } => {
                    // `[-5 3]` reads as the number -5.
                    if let Some(Token { tok: Tok::Num(n), .. }) = self.toks.get(self.pos + 1).filter(|_| self.pos + 1 < self.end) {
                        items.push(Value::Num(-n));
                        self.pos += 2;
                    } else {
                        items.push(Value::Word(Rc::from("-")));
                        self.pos += 1;
                    }
                }
                Tok::Plus => op_word(&mut items, "+", &mut self.pos),
                Tok::Minus { .. } => op_word(&mut items, "-", &mut self.pos),
                Tok::Star => op_word(&mut items, "*", &mut self.pos),
                Tok::Slash => op_word(&mut items, "/", &mut self.pos),
                Tok::Eq => op_word(&mut items, "=", &mut self.pos),
                Tok::Lt => op_word(&mut items, "<", &mut self.pos),
                Tok::Gt => op_word(&mut items, ">", &mut self.pos),
                Tok::Le => op_word(&mut items, "<=", &mut self.pos),
                Tok::Ge => op_word(&mut items, ">=", &mut self.pos),
                Tok::Ne => op_word(&mut items, "<>", &mut self.pos),
                Tok::LParen => op_word(&mut items, "(", &mut self.pos),
                Tok::RParen => op_word(&mut items, ")", &mut self.pos),
                Tok::Lit(v) => {
                    items.push(v.clone());
                    self.pos += 1;
                }
            }
        }
    }
}

fn op_word(items: &mut Vec<Value>, s: &str, pos: &mut usize) {
    items.push(Value::Word(Rc::from(s)));
    *pos += 1;
}

/// Pack a token index range into the `u64` a `ListVal.lit` carries.
pub fn pack_range(start: usize, end: usize) -> u64 {
    ((start as u64) << 32) | end as u64
}
pub fn unpack_range(packed: u64) -> (usize, usize) {
    ((packed >> 32) as usize, (packed & 0xffff_ffff) as usize)
}
