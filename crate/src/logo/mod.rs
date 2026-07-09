//! Logo turtle-graphics interpreter — the `logo` element's generator. UCB-style dialect (see
//! `builtins.rs` for the vocabulary): procedures with full recursion (tail calls run in constant
//! space), dynamic scoping, lists as data *and* code, seeded `random`, and turtle output in
//! element-local mm via `turtle.rs`.
//!
//! Everything is deterministic for `(source, args, seed)` — no wall clock anywhere — because the
//! registry memoizes geometry on a hash of exactly those params. Runaway programs are cut off by
//! the deterministic budget in `Limits` (steps / call depth / points / strokes), never by time.
//!
//! `run` takes the element params as one JSON string and returns strokes or a `LogoError`
//! serialized as JSON (`{message, line, col, from, to}` — from/to are UTF-16 code units for the
//! CodeMirror editor; line/col are 1-based for the human-readable banner).

pub mod analyze;
mod builtins;
mod eval;
mod lex;
mod parse;
mod turtle;
mod value;

use std::collections::HashMap;

use lex::Span;
pub use eval::RunResult;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrKind {
    Parse,
    Runtime,
    Limit,
}

#[derive(Clone, Debug)]
pub struct LogoError {
    pub kind: ErrKind,
    pub message: String,
    pub span: Span,
}

impl LogoError {
    pub fn parse(message: &str, span: Span) -> Self {
        LogoError { kind: ErrKind::Parse, message: message.to_string(), span }
    }
    pub fn runtime(message: &str, span: Span) -> Self {
        LogoError { kind: ErrKind::Runtime, message: message.to_string(), span }
    }
    pub fn limit(message: &str, span: Span) -> Self {
        LogoError { kind: ErrKind::Limit, message: message.to_string(), span }
    }
}

/// Deterministic execution budget. Violations abort with a spanned `Limit` error; there is no
/// wall-clock cutoff (determinism is a memoization contract, see module docs).
pub struct Limits {
    pub max_steps: u64,
    pub max_depth: usize,
    pub max_points: usize,
    pub max_strokes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_steps: 5_000_000,
            // Each Logo frame costs several Rust frames of eval recursion, and the WASM stack is
            // ~1 MB — 256 non-tail frames is deep enough for any tree fractal (depth ~20) while
            // leaving comfortable headroom. Tail calls don't count (they run in constant space).
            max_depth: 256,
            max_points: 2_000_000,
            max_strokes: 200_000,
        }
    }
}

#[derive(serde::Deserialize)]
struct RunParams {
    source: String,
    #[serde(default)]
    args: HashMap<String, f64>,
    #[serde(default)]
    seed: u32,
}

/// Run a Logo program. `params_json` = `{"source": string, "args": {name: number}, "seed": n}`.
/// The `Err` string is the JSON-serialized `LogoError`.
pub fn run(params_json: &str) -> Result<RunResult, String> {
    let p: RunParams = match serde_json::from_str(params_json) {
        Ok(p) => p,
        Err(e) => return Err(error_json_raw(&format!("bad params: {}", e), 1, 1, 0, 0)),
    };
    run_source(&p.source, p.args, p.seed, Limits::default()).map_err(|e| error_json(&e, &p.source))
}

/// Parse + execute with explicit limits (tests use small budgets).
pub fn run_source(
    source: &str,
    args: HashMap<String, f64>,
    seed: u32,
    limits: Limits,
) -> Result<RunResult, LogoError> {
    let tokens = lex::lex(source)?;
    let program = parse::parse_program(tokens)?;
    eval::run(program, args, seed, limits)
}

/// Serialize an error with positions resolved against the source: 1-based line/col for the
/// banner, UTF-16 code-unit from/to for the editor.
pub fn error_json(e: &LogoError, source: &str) -> String {
    let (line, col) = line_col(source, e.span.start as usize);
    let from = utf16_offset(source, e.span.start as usize);
    let to = utf16_offset(source, e.span.end as usize).max(from);
    error_json_raw(&e.message, line, col, from, to)
}

fn error_json_raw(message: &str, line: usize, col: usize, from: usize, to: usize) -> String {
    serde_json::json!({
        "message": message,
        "line": line,
        "col": col,
        "from": from,
        "to": to,
    })
    .to_string()
}

/// 1-based line/column (in characters) of a byte offset.
fn line_col(src: &str, byte: usize) -> (usize, usize) {
    let byte = byte.min(src.len());
    let before = &src[..byte];
    let line = before.bytes().filter(|&b| b == b'\n').count() + 1;
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let col = before[line_start..].chars().count() + 1;
    (line, col)
}

/// Byte offset → UTF-16 code-unit offset (CodeMirror positions are UTF-16).
fn utf16_offset(src: &str, byte: usize) -> usize {
    let byte = byte.min(src.len());
    src[..byte].chars().map(|c| c.len_utf16()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Stroke;

    fn run_ok(src: &str) -> Vec<Stroke> {
        run_source(src, HashMap::new(), 1, Limits::default())
            .unwrap_or_else(|e| panic!("{}: {:?}", src, e))
            .strokes
    }
    fn run_err(src: &str) -> LogoError {
        match run_source(src, HashMap::new(), 1, Limits::default()) {
            Ok(_) => panic!("{}: expected an error", src),
            Err(e) => e,
        }
    }
    /// End position of the single stroke, as (x, page-y).
    fn end_pos(strokes: &[Stroke]) -> (f32, f32) {
        let p = strokes.last().unwrap().points.last().unwrap();
        (p.x, p.y)
    }
    fn total_points(strokes: &[Stroke]) -> usize {
        strokes.iter().map(|s| s.points.len()).sum()
    }

    // ── parsing ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn greedy_arity_and_precedence() {
        // sum 2 3 * 4 = 2 + 12; fd that distance then nothing else.
        let s = run_ok("fd sum 2 3 * 4");
        assert_eq!(end_pos(&s), (0.0, -14.0));
        // Infix binds inside an argument: fd 2 + 3 = fd 5.
        let s = run_ok("fd 2 + 3");
        assert_eq!(end_pos(&s), (0.0, -5.0));
    }

    #[test]
    fn explicit_arity_parens() {
        let s = run_ok("fd (sum 1 2 3 4)");
        assert_eq!(end_pos(&s), (0.0, -10.0));
        let e = run_err("fd (fd 1 2)");
        assert!(e.message.contains("takes 1 input"), "{}", e.message);
    }

    #[test]
    fn unary_minus_statements() {
        // `fd 10 -5` = fd 10, then a dangling -5.
        let e = run_err("fd 10 -5");
        assert!(e.message.contains("you don't say what to do with -5"), "{}", e.message);
        // `fd 10 - 5` = fd 5.
        let s = run_ok("fd 10 - 5");
        assert_eq!(end_pos(&s), (0.0, -5.0));
    }

    #[test]
    fn unknown_procedure_is_a_parse_error() {
        let e = run_err("fwd 10");
        assert_eq!(e.kind, ErrKind::Parse);
        assert!(e.message.contains("I don't know how to fwd"));
        assert_eq!(e.span.start, 0);
        assert_eq!(e.span.end, 3);
    }

    #[test]
    fn two_pass_forward_reference() {
        // square is used before it's defined — pass 1 makes that fine.
        let s = run_ok("square 10\nto square :n\nrepeat 4 [fd :n rt 90]\nend");
        assert_eq!(s.len(), 1);
        assert_eq!(total_points(&s), 5);
    }

    #[test]
    fn to_errors() {
        assert!(run_err("to square\nfd 10").message.contains("no end"));
        assert!(run_err("end").message.contains("end without to"));
        assert!(run_err("to fd :n\nend").message.contains("built-in"));
        assert!(run_err("to a\nto b\nend\nend").message.contains("to inside a procedure"));
    }

    // ── evaluation ──────────────────────────────────────────────────────────────────────────────

    #[test]
    fn dynamic_scoping_make_reaches_callers_local() {
        // helper's make "x sets the caller's local, not a global; drawing distance proves it.
        let src = "
to helper
make \"x 42
end
to main
local \"x
make \"x 1
helper
fd :x
end
main";
        let s = run_ok(src);
        assert_eq!(end_pos(&s), (0.0, -42.0));
    }

    #[test]
    fn output_and_stop() {
        let s = run_ok("to double :n\noutput :n * 2\nend\nfd double 21");
        assert_eq!(end_pos(&s), (0.0, -42.0));
        let s = run_ok("to maybe :n\nif :n > 5 [stop]\nfd :n\nend\nmaybe 3 maybe 10");
        assert_eq!(end_pos(&s), (0.0, -3.0));
    }

    #[test]
    fn tail_recursion_runs_in_constant_space() {
        // 100k-deep tail spiral must succeed (far beyond max_depth).
        let src = "
to spin :n
if :n = 0 [stop]
rt 1
spin :n - 1
end
spin 100000
fd 10";
        let s = run_source(src, HashMap::new(), 1, Limits { max_steps: 10_000_000, ..Limits::default() }).unwrap().strokes;
        assert_eq!(s.len(), 1); // it got to the fd
    }

    #[test]
    fn non_tail_recursion_hits_depth_limit() {
        // fd AFTER the recursive call → not a tail call → depth-limited, not a crash. A small
        // custom cap tests the mechanism without needing a deep Rust stack in debug builds.
        let src = "
to f :n
f :n + 1
fd 1
end
f 0";
        let e = match run_source(src, HashMap::new(), 1, Limits { max_depth: 64, ..Limits::default() }) {
            Err(e) => e,
            Ok(_) => panic!("expected depth limit"),
        };
        assert_eq!(e.kind, ErrKind::Limit);
        assert!(e.message.contains("too deep"), "{}", e.message);
    }

    #[test]
    fn step_limit_fires() {
        let e = match run_source("while [1 < 2] [rt 1]", HashMap::new(), 1, Limits { max_steps: 10_000, ..Limits::default() }) {
            Err(e) => e,
            Ok(_) => panic!("expected step limit"),
        };
        assert_eq!(e.kind, ErrKind::Limit);
        assert!(e.message.contains("too many steps"));
    }

    #[test]
    fn point_limit_fires() {
        let e = match run_source(
            "repeat 100000 [fd 1 rt 1]",
            HashMap::new(),
            1,
            Limits { max_points: 1000, ..Limits::default() },
        ) {
            Err(e) => e,
            Ok(_) => panic!("expected point limit"),
        };
        assert_eq!(e.kind, ErrKind::Limit);
        assert!(e.message.contains("too many points"));
    }

    #[test]
    fn repeat_repcount_ifelse() {
        // Distances 1..4 chained straight up.
        let s = run_ok("repeat 4 [fd repcount]");
        assert_eq!(end_pos(&s), (0.0, -10.0));
        let s = run_ok("fd ifelse 2 > 1 [10] [20]");
        assert_eq!(end_pos(&s), (0.0, -10.0));
    }

    #[test]
    fn for_and_while() {
        let s = run_ok("for [i 1 4] [fd :i]");
        assert_eq!(end_pos(&s), (0.0, -10.0));
        // Expressions in the control list; step.
        let s = run_ok("make \"n 2 for [i 0 :n * 2 2] [fd 1]"); // i = 0, 2, 4 → 3 moves
        assert_eq!(end_pos(&s), (0.0, -3.0));
        let s = run_ok("make \"i 0 while [:i < 5] [fd 1 make \"i :i + 1]");
        assert_eq!(end_pos(&s), (0.0, -5.0));
    }

    #[test]
    fn lists_as_data_and_code() {
        // map/filter/foreach over data; run of a built list.
        let s = run_ok("foreach [1 2 3] [fd ?]");
        assert_eq!(end_pos(&s), (0.0, -6.0));
        let s = run_ok("foreach map [? * 2] [1 2 3] [fd ?]");
        assert_eq!(end_pos(&s), (0.0, -12.0));
        let s = run_ok("foreach filter [? > 1] [1 2 3] [fd ?]");
        assert_eq!(end_pos(&s), (0.0, -5.0));
        let s = run_ok("run [fd 7]");
        assert_eq!(end_pos(&s), (0.0, -7.0));
        // Runtime-built code list.
        let s = run_ok("run list \"fd 9");
        assert_eq!(end_pos(&s), (0.0, -9.0));
        // List ops.
        let s = run_ok("fd first [4 5] fd last [4 5] fd count [a b c] fd item 2 [7 8 9]");
        assert_eq!(end_pos(&s), (0.0, -20.0));
    }

    #[test]
    fn word_ops() {
        let s = run_ok("fd count word \"ab \"cde"); // 5
        assert_eq!(end_pos(&s), (0.0, -5.0));
        let s = run_ok("if empty? butfirst \"x [fd 3]");
        assert_eq!(end_pos(&s), (0.0, -3.0));
        // Words coerce to numbers.
        let s = run_ok("fd sum \"3 \"4");
        assert_eq!(end_pos(&s), (0.0, -7.0));
    }

    #[test]
    fn seeded_random_is_deterministic() {
        let a = run_source("repeat 20 [fd random 10 rt random 360]", HashMap::new(), 7, Limits::default()).unwrap().strokes;
        let b = run_source("repeat 20 [fd random 10 rt random 360]", HashMap::new(), 7, Limits::default()).unwrap().strokes;
        let c = run_source("repeat 20 [fd random 10 rt random 360]", HashMap::new(), 8, Limits::default()).unwrap().strokes;
        let flat = |s: &[Stroke]| s.iter().flat_map(|st| st.points.iter().map(|p| (p.x, p.y))).collect::<Vec<_>>();
        assert_eq!(flat(&a), flat(&b), "same seed must reproduce");
        assert_ne!(flat(&a), flat(&c), "different seed must differ");
    }

    #[test]
    fn param_defaults_and_overrides() {
        let src = "param \"size 10 [1 50]\nfd :size";
        let s = run_ok(src);
        assert_eq!(end_pos(&s), (0.0, -10.0));
        let mut args = HashMap::new();
        args.insert("size".to_string(), 30.0);
        let s = run_source(src, args, 1, Limits::default()).unwrap().strokes;
        assert_eq!(end_pos(&s), (0.0, -30.0));
        // Overrides clamp to the declared range.
        let mut args = HashMap::new();
        args.insert("size".to_string(), 500.0);
        let s = run_source(src, args, 1, Limits::default()).unwrap().strokes;
        assert_eq!(end_pos(&s), (0.0, -50.0));
    }

    #[test]
    fn param_step_snaps_overrides() {
        let src = "param \"n 4 [0 10 2]\nfd :n";
        // Default is untouched by the step.
        let s = run_ok(src);
        assert_eq!(end_pos(&s), (0.0, -4.0));
        // 5.4 snaps to 6 on the [0, 10] grid of 2s.
        let mut args = HashMap::new();
        args.insert("n".to_string(), 5.4);
        let s = run_source(src, args, 1, Limits::default()).unwrap().strokes;
        assert_eq!(end_pos(&s), (0.0, -6.0));
        // Snap happens before the clamp: 9.9 → 10.
        let mut args = HashMap::new();
        args.insert("n".to_string(), 9.9);
        let s = run_source(src, args, 1, Limits::default()).unwrap().strokes;
        assert_eq!(end_pos(&s), (0.0, -10.0));
    }

    #[test]
    fn final_pose_is_reported() {
        let r = run_source("fd 10 rt 90 fd 5", HashMap::new(), 1, Limits::default()).unwrap();
        assert!((r.pose.x - 5.0).abs() < 1e-4, "x {}", r.pose.x);
        assert!((r.pose.y - -10.0).abs() < 1e-4, "page y {}", r.pose.y);
        assert!((r.pose.heading - 90.0).abs() < 1e-4);
        // Pen-up moves still move the pose.
        let r = run_source("pu setxy 7 3", HashMap::new(), 1, Limits::default()).unwrap();
        assert_eq!((r.pose.x, r.pose.y), (7.0, -3.0));
    }

    #[test]
    fn setpen_and_pressure_flow_to_strokes() {
        let s = run_ok("fd 5 setpen 1 setpressure 0.5 fd 5");
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].pen, s[1].pen), (0, 1));
        assert_eq!(s[1].points.last().unwrap().pressure, 0.5);
    }

    #[test]
    fn errors_have_positions() {
        let e = run_err("fd 10\nfd [1]");
        let json = error_json(&e, "fd 10\nfd [1]");
        assert!(json.contains("\"line\":2"), "{}", json);
        // UTF-16 offsets survive non-ASCII: the 🐢 is 2 UTF-16 units, 4 bytes.
        let src = "; 🐢\nnope";
        let e = run_err(src);
        let json = error_json(&e, src);
        // "; 🐢\n" = 5 UTF-16 units (2 for the turtle) → `nope` starts at 5.
        assert!(json.contains("\"from\":5"), "{}", json);
        assert!(json.contains("\"line\":2"), "{}", json);
    }

    #[test]
    fn you_dont_say_and_didnt_output() {
        let e = run_err("sum 1 2");
        assert!(e.message.contains("you don't say what to do with 3"), "{}", e.message);
        let e = run_err("fd fd 1");
        assert!(e.message.contains("fd didn't output a value"), "{}", e.message);
    }

    #[test]
    fn division_by_zero_and_math_domain() {
        assert!(run_err("fd 1 / 0").message.contains("division by zero"));
        assert!(run_err("fd sqrt -1").message.contains("isn't a number"));
    }

    #[test]
    fn empty_program_is_empty_geometry() {
        assert!(run_ok("").is_empty());
        assert!(run_ok("; just a comment").is_empty());
    }

    #[test]
    fn run_entry_point_json() {
        let strokes = run(r#"{"source": "repeat 4 [fd 10 rt 90]", "args": {}, "seed": 1}"#).unwrap().strokes;
        assert_eq!(strokes.len(), 1);
        let err = run(r#"{"source": "nope", "args": {}, "seed": 1}"#).unwrap_err();
        assert!(err.contains("I don't know how to nope"), "{}", err);
        assert!(err.contains("\"from\":0"), "{}", err);
    }
}
