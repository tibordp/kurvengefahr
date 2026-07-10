//! Static analysis for the editor + inspector: one parse serves diagnostics, `param` extraction,
//! and the symbol table (user procedures / globals). Parse-only — nothing executes, so it's safe
//! and fast enough to run synchronously on the main thread as the user types.
//!
//! **All offsets in the JSON are UTF-16 code units** (CodeMirror's position space), converted from
//! the interpreter's byte spans at this boundary. `usesRandom` is detected on the *token* stream —
//! `random` usually sits inside `[...]` blocks, which parse as data, so an AST walk would miss it.

use serde::Serialize;

use super::builtins::{self, B, BUILTINS};
use super::lex::{self, Span, Tok};
use super::parse::{self, Expr, ExprKind};
use super::value::Value;
use super::{utf16_offset, LogoError};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    from: usize,
    to: usize,
    severity: &'static str, // "error" | "warning"
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParamDecl {
    name: String,
    kind: &'static str, // "number" (room for select/checkbox later)
    default: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProcInfo {
    name: String,
    arg_names: Vec<String>,
    from: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Analysis {
    diagnostics: Vec<Diagnostic>,
    params: Vec<ParamDecl>,
    procs: Vec<ProcInfo>,
    globals: Vec<String>,
    uses_random: bool,
}

pub fn analyze(source: &str) -> String {
    serde_json::to_string(&analyze_impl(source)).expect("analysis serializes")
}

fn analyze_impl(source: &str) -> Analysis {
    let mut out = Analysis {
        diagnostics: Vec::new(),
        params: Vec::new(),
        procs: Vec::new(),
        globals: Vec::new(),
        uses_random: false,
    };
    let diag = |e: &LogoError, severity: &'static str, src: &str| {
        let from = utf16_offset(src, e.span.start as usize);
        let to = utf16_offset(src, e.span.end as usize).max(from);
        Diagnostic {
            from,
            to,
            severity,
            message: e.message.clone(),
        }
    };

    let tokens = match lex::lex(source) {
        Ok(t) => t,
        Err(e) => {
            out.diagnostics.push(diag(&e, "error", source));
            return out;
        }
    };
    out.uses_random = tokens.iter().any(|t| {
        matches!(&t.tok, Tok::Ident(n) if matches!(builtins::lookup(n).map(|b| b.id), Some(B::Random | B::Pick | B::ReRandom)))
    });

    let program = match parse::parse_program(tokens) {
        Ok(p) => p,
        Err(e) => {
            out.diagnostics.push(diag(&e, "error", source));
            return out;
        }
    };

    for p in &program.procs {
        out.procs.push(ProcInfo {
            name: p.name.to_string(),
            arg_names: p.params.iter().map(|a| a.to_string()).collect(),
            from: utf16_offset(source, p.name_span.start as usize),
        });
    }

    // `param` declarations: literal + top-level ones become inspector knobs; anything else still
    // runs but gets a warning and no knob. Top-level `make "name …` also counts as a global.
    collect_globals(&program.body, source, true, &mut out);
    let prog_rc = program;
    for p in &prog_rc.procs {
        collect_globals(&p.body, source, false, &mut out);
    }

    out
}

fn warn(out: &mut Analysis, source: &str, span: Span, message: &str) {
    let from = utf16_offset(source, span.start as usize);
    let to = utf16_offset(source, span.end as usize).max(from);
    out.diagnostics.push(Diagnostic {
        from,
        to,
        severity: "warning",
        message: message.to_string(),
    });
}

/// Walk a statement list for `param`/`make` declarations. `top_level` gates whether `param`
/// produces a knob (inside a procedure it only warns).
fn collect_globals(body: &[Expr], source: &str, top_level: bool, out: &mut Analysis) {
    for stmt in body {
        let ExprKind::Call { b, args, .. } = &stmt.kind else {
            continue;
        };
        match b {
            Some(B::Param) => {
                if !top_level {
                    warn(out, source, stmt.span, "param inside a procedure won't appear in the inspector — declare it at the top level");
                    continue;
                }
                let Some(name) = literal_word(&args[0]) else {
                    warn(out, source, stmt.span, "param needs a literal name (like param \"size 40) to appear in the inspector");
                    continue;
                };
                let Some(default) = args.get(1).and_then(literal_num) else {
                    warn(
                        out,
                        source,
                        stmt.span,
                        "param needs a literal number default to appear in the inspector",
                    );
                    continue;
                };
                let range = args.get(2).and_then(literal_range);
                if args.len() > 2 && range.is_none() {
                    warn(
                        out,
                        source,
                        stmt.span,
                        "param's range must be literal numbers, like [10 80] or [10 80 5]",
                    );
                }
                if let Some(prev) = out.params.iter().position(|p| p.name == name) {
                    warn(
                        out,
                        source,
                        stmt.span,
                        &format!(
                            "param \"{} is declared twice — the last declaration wins",
                            name
                        ),
                    );
                    out.params.remove(prev);
                }
                let (min, max, step) = match range {
                    Some((lo, hi, step)) => (
                        Some(lo.min(hi)),
                        Some(lo.max(hi)),
                        step.filter(|&s| s > 0.0),
                    ),
                    None => (None, None, None),
                };
                if !out.globals.contains(&name) {
                    out.globals.push(name.clone());
                }
                out.params.push(ParamDecl {
                    name,
                    kind: "number",
                    default,
                    min,
                    max,
                    step,
                });
            }
            Some(B::Make) | Some(B::LocalMake) if top_level && matches!(b, Some(B::Make)) => {
                if let Some(name) = literal_word(&args[0]) {
                    if !out.globals.contains(&name) {
                        out.globals.push(name);
                    }
                }
            }
            _ => {}
        }
    }
}

fn literal_word(e: &Expr) -> Option<String> {
    match &e.kind {
        ExprKind::Word(w) => Some(w.to_ascii_lowercase()),
        _ => None,
    }
}

fn literal_num(e: &Expr) -> Option<f64> {
    match &e.kind {
        ExprKind::Num(n) => Some(*n),
        ExprKind::Neg(inner) => match &inner.kind {
            ExprKind::Num(n) => Some(-n),
            _ => None,
        },
        _ => None,
    }
}

/// `[min max]` or `[min max step]` of literal numbers.
fn literal_range(e: &Expr) -> Option<(f64, f64, Option<f64>)> {
    let ExprKind::Lit(Value::List(l)) = &e.kind else {
        return None;
    };
    if !(2..=3).contains(&l.items.len()) {
        return None;
    }
    let mut nums = Vec::with_capacity(l.items.len());
    for it in &l.items {
        match it {
            Value::Num(n) => nums.push(*n),
            _ => return None,
        }
    }
    Some((nums[0], nums[1], nums.get(2).copied()))
}

/// The builtin vocabulary as JSON, for editor autocomplete. Stable: name/aliases/args/doc/category
/// straight from the table (see `builtins.rs`).
pub fn builtins_json() -> String {
    #[derive(Serialize)]
    struct Entry {
        name: &'static str,
        aliases: &'static [&'static str],
        args: &'static [&'static str],
        doc: &'static str,
        category: &'static str,
    }
    let entries: Vec<Entry> = BUILTINS
        .iter()
        .map(|b| Entry {
            name: b.name,
            aliases: b.aliases,
            args: b.args,
            doc: b.doc,
            category: b.category,
        })
        .collect();
    serde_json::to_string(&entries).expect("builtins serialize")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(src: &str) -> serde_json::Value {
        serde_json::from_str(&analyze(src)).unwrap()
    }

    #[test]
    fn extracts_literal_params() {
        let a = parsed("param \"petals 7 [3 24]\nparam \"wobble 0.5\nrepeat :petals [fd :wobble]");
        let params = a["params"].as_array().unwrap();
        assert_eq!(params.len(), 2);
        assert_eq!(params[0]["name"], "petals");
        assert_eq!(params[0]["default"], 7.0);
        assert_eq!(params[0]["min"], 3.0);
        assert_eq!(params[0]["max"], 24.0);
        assert_eq!(params[1]["name"], "wobble");
        assert!(params[1].get("min").is_none());
        assert_eq!(a["diagnostics"].as_array().unwrap().len(), 0);
        assert_eq!(a["usesRandom"], false);
    }

    #[test]
    fn negative_default_and_swapped_range() {
        let a = parsed("param \"dip -5 [10 -10]\nfd :dip");
        let p = &a["params"][0];
        assert_eq!(p["default"], -5.0);
        assert_eq!(p["min"], -10.0);
        assert_eq!(p["max"], 10.0);
        assert!(p.get("step").is_none());
    }

    #[test]
    fn range_step_extracted() {
        let a = parsed("param \"sides 5 [3 12 1]\nfd :sides");
        let p = &a["params"][0];
        assert_eq!(p["min"], 3.0);
        assert_eq!(p["max"], 12.0);
        assert_eq!(p["step"], 1.0);
        // A non-positive step is dropped (no silent surprises in the knob).
        let a = parsed("param \"x 1 [0 10 0]\nfd :x");
        assert!(a["params"][0].get("step").is_none());
    }

    #[test]
    fn non_literal_param_warns_and_is_excluded() {
        let a = parsed("param \"a 1 + 2\nfd :a");
        assert_eq!(a["params"].as_array().unwrap().len(), 0);
        let d = &a["diagnostics"][0];
        assert_eq!(d["severity"], "warning");
    }

    #[test]
    fn param_in_procedure_warns() {
        let a = parsed("to f\nparam \"x 1\nfd :x\nend\nf");
        assert_eq!(a["params"].as_array().unwrap().len(), 0);
        assert!(a["diagnostics"][0]["message"]
            .as_str()
            .unwrap()
            .contains("top level"));
    }

    #[test]
    fn duplicate_param_warns_last_wins() {
        let a = parsed("param \"x 1\nparam \"x 2\nfd :x");
        let params = a["params"].as_array().unwrap();
        assert_eq!(params.len(), 1);
        assert_eq!(params[0]["default"], 2.0);
        assert_eq!(a["diagnostics"][0]["severity"], "warning");
    }

    #[test]
    fn procs_and_globals() {
        let a = parsed("make \"phase 0\nto petal :len :w\nfd :len\nend\npetal 5 1");
        assert_eq!(a["procs"][0]["name"], "petal");
        assert_eq!(a["procs"][0]["argNames"][1], "w");
        assert!(a["globals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g == "phase"));
    }

    #[test]
    fn uses_random_detected_inside_blocks() {
        assert_eq!(parsed("repeat 4 [fd random 10]")["usesRandom"], true);
        assert_eq!(parsed("fd pick [1 2 3]")["usesRandom"], true);
        assert_eq!(parsed("fd 10")["usesRandom"], false);
    }

    #[test]
    fn parse_error_diagnostic_offsets_are_utf16() {
        // "; 🐢\n" is 5 UTF-16 units (the turtle is 2), 7 bytes.
        let a = parsed("; 🐢\nnope 1");
        let d = &a["diagnostics"][0];
        assert_eq!(d["severity"], "error");
        assert_eq!(d["from"], 5);
        assert_eq!(d["to"], 9);
        assert!(d["message"]
            .as_str()
            .unwrap()
            .contains("I don't know how to nope"));
    }

    #[test]
    fn builtins_json_is_well_formed() {
        let v: serde_json::Value = serde_json::from_str(&builtins_json()).unwrap();
        let arr = v.as_array().unwrap();
        assert!(arr.len() > 80);
        let fd = arr.iter().find(|b| b["name"] == "forward").unwrap();
        assert_eq!(fd["aliases"][0], "fd");
        assert_eq!(fd["category"], "turtle");
    }
}
