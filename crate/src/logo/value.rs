//! Logo's value model: numbers, words, lists, booleans. Lists are immutable (`Rc`d vectors) —
//! `fput`/`butfirst` build new vectors, which is fine at plotter scale and keeps sharing free.
//! A list built from a *source literal* remembers its token range so `run`/`repeat`-as-code can
//! re-parse the original tokens (with real spans) and cache the parsed body.

use std::rc::Rc;

#[derive(Clone, Debug)]
pub enum Value {
    Num(f64),
    Bool(bool),
    Word(Rc<str>),
    List(Rc<ListVal>),
}

#[derive(Debug)]
pub struct ListVal {
    pub items: Vec<Value>,
    /// Set when this list is a source literal: the packed token range of its content (see
    /// `parse::pack_range`). Enables the parsed-as-code cache + real spans inside the list.
    pub lit: Option<u64>,
}

impl Value {
    pub fn list(items: Vec<Value>) -> Value {
        Value::List(Rc::new(ListVal { items, lit: None }))
    }

    /// Coerce to a number. Words that read as numbers coerce (`"3 + 4` is 7, per UCB).
    pub fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Word(w) => w.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    /// Coerce to a boolean. The words `true`/`false` count (UCB compatibility).
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            Value::Word(w) if w.eq_ignore_ascii_case("true") => Some(true),
            Value::Word(w) if w.eq_ignore_ascii_case("false") => Some(false),
            _ => None,
        }
    }

    /// Coerce to a word (numbers/booleans format themselves; lists don't coerce).
    pub fn as_word(&self) -> Option<Rc<str>> {
        match self {
            Value::Word(w) => Some(w.clone()),
            Value::Num(n) => Some(fmt_num(*n).into()),
            Value::Bool(b) => Some(if *b { "true".into() } else { "false".into() }),
            Value::List(_) => None,
        }
    }

    /// Logo equality: numeric when both sides read as numbers, else case-insensitive words,
    /// element-wise for lists.
    pub fn logo_eq(&self, other: &Value) -> bool {
        if let (Some(a), Some(b)) = (self.as_num(), other.as_num()) {
            return a == b;
        }
        match (self, other) {
            (Value::List(a), Value::List(b)) => {
                a.items.len() == b.items.len()
                    && a.items.iter().zip(&b.items).all(|(x, y)| x.logo_eq(y))
            }
            (Value::List(_), _) | (_, Value::List(_)) => false,
            _ => match (self.as_word(), other.as_word()) {
                (Some(a), Some(b)) => a.eq_ignore_ascii_case(&b),
                _ => false,
            },
        }
    }
}

/// Format a number the way Logo prints it: integers without a decimal point.
pub fn fmt_num(n: f64) -> String {
    if n.is_finite() && n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

/// Short display form for error messages ("you don't say what to do with X").
pub fn display(v: &Value) -> String {
    match v {
        Value::Num(n) => fmt_num(*n),
        Value::Bool(b) => b.to_string(),
        Value::Word(w) => w.to_string(),
        Value::List(l) => {
            let inner: Vec<String> = l.items.iter().map(display).collect();
            format!("[{}]", inner.join(" "))
        }
    }
}
