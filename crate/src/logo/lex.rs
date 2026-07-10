//! Logo tokenizer. Every token carries a byte-offset `Span` into the source (diagnostics convert
//! to line/col and UTF-16 offsets at the boundary) and its 1-based line (the `to` header is
//! newline-terminated; nothing else is line-sensitive).
//!
//! The classic Logo ambiguity — unary vs infix minus — is resolved with the UCB rule, decided
//! lexically: a `-` is *unary-hinted* when it is preceded by start-of-input / whitespace / `(` /
//! `[` / another operator AND immediately followed by a non-space. So `fd -10` negates, `:a - 5`
//! and `:a-5` subtract, and `fd 10 -5` is `fd 10` followed by a dangling `-5` (a precise runtime
//! error rather than a silent subtraction). The parser treats a unary-hinted minus after a
//! complete operand as the *start of the next statement/argument*, never as subtraction.

use super::value::Value;
use super::LogoError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: u32,
    pub end: u32,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Span {
            start: start as u32,
            end: end as u32,
        }
    }
    /// The smallest span covering both.
    pub fn merge(a: Span, b: Span) -> Span {
        Span {
            start: a.start.min(b.start),
            end: a.end.max(b.end),
        }
    }
}

#[derive(Clone, Debug)]
pub enum Tok {
    Num(f64),
    /// `"foo` — content after the quote, case preserved (lowercased at name-binding use sites).
    Word(String),
    /// `:foo` — lowercased.
    Var(String),
    /// Bare word: builtin / user procedure / `to` / `end`. Lowercased.
    Ident(String),
    LBracket,
    RBracket,
    LParen,
    RParen,
    Plus,
    Minus {
        /// Lexical unary hint (see module docs).
        unary: bool,
    },
    Star,
    Slash,
    Eq,
    Lt,
    Gt,
    Le,
    Ge,
    Ne,
    /// Only in synthetic streams built from runtime lists (`run` on a constructed list): a value
    /// that stands for itself. Never produced by `lex`.
    Lit(Value),
}

#[derive(Clone)]
pub struct Token {
    pub tok: Tok,
    pub span: Span,
    pub line: u32,
}

fn is_word_char(c: char) -> bool {
    !c.is_whitespace()
        && !matches!(
            c,
            '(' | ')' | '[' | ']' | '+' | '-' | '*' | '/' | '=' | '<' | '>' | ';' | '"' | ':'
        )
}

pub fn lex(src: &str) -> Result<Vec<Token>, LogoError> {
    let bytes = src.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    let mut line = 1u32;
    // Byte index of the last non-whitespace char before the cursor, for the unary-minus rule.
    let mut prev_significant: Option<u8> = None;

    while i < bytes.len() {
        let c = src[i..].chars().next().unwrap();
        if c == '\n' {
            line += 1;
            i += 1;
            prev_significant = None; // line start behaves like start-of-input
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            prev_significant = None; // whitespace resets the "glued" context
            continue;
        }
        if c == ';' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        let start = i;
        let tok = match c {
            '(' => {
                i += 1;
                Tok::LParen
            }
            ')' => {
                i += 1;
                Tok::RParen
            }
            '[' => {
                i += 1;
                Tok::LBracket
            }
            ']' => {
                i += 1;
                Tok::RBracket
            }
            '+' => {
                i += 1;
                Tok::Plus
            }
            '*' => {
                i += 1;
                Tok::Star
            }
            '/' => {
                i += 1;
                Tok::Slash
            }
            '=' => {
                i += 1;
                Tok::Eq
            }
            '<' => {
                i += 1;
                if bytes.get(i) == Some(&b'=') {
                    i += 1;
                    Tok::Le
                } else if bytes.get(i) == Some(&b'>') {
                    i += 1;
                    Tok::Ne
                } else {
                    Tok::Lt
                }
            }
            '>' => {
                i += 1;
                if bytes.get(i) == Some(&b'=') {
                    i += 1;
                    Tok::Ge
                } else {
                    Tok::Gt
                }
            }
            '-' => {
                // Unary-hinted iff not glued to a preceding operand and glued to what follows.
                let prev_operandish = matches!(prev_significant, Some(p) if p == b')' || p == b']' || is_word_char(p as char) || p == b'"');
                let next_glued = bytes
                    .get(i + 1)
                    .is_some_and(|&n| !(n as char).is_whitespace() && n != b';');
                i += 1;
                Tok::Minus {
                    unary: !prev_operandish && next_glued,
                }
            }
            '"' => {
                i += 1;
                let ws = i;
                while i < bytes.len() && is_word_char(src[i..].chars().next().unwrap()) {
                    i += src[i..].chars().next().unwrap().len_utf8();
                }
                Tok::Word(src[ws..i].to_string())
            }
            ':' => {
                i += 1;
                let ws = i;
                while i < bytes.len() && is_word_char(src[i..].chars().next().unwrap()) {
                    i += src[i..].chars().next().unwrap().len_utf8();
                }
                if ws == i {
                    return Err(LogoError::parse(
                        "expected a variable name after :",
                        Span::new(start, i),
                    ));
                }
                Tok::Var(src[ws..i].to_ascii_lowercase())
            }
            _ if c.is_ascii_digit()
                || (c == '.' && bytes.get(i + 1).is_some_and(|n| n.is_ascii_digit())) =>
            {
                let ws = i;
                while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                    i += 1;
                }
                // Optional exponent: e / E, optional sign, digits.
                if i < bytes.len()
                    && (bytes[i] == b'e' || bytes[i] == b'E')
                    && bytes.get(i + 1).is_some_and(|&n| {
                        n.is_ascii_digit()
                            || ((n == b'+' || n == b'-')
                                && bytes.get(i + 2).is_some_and(|d| d.is_ascii_digit()))
                    })
                {
                    i += 2;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                }
                let text = &src[ws..i];
                match text.parse::<f64>() {
                    Ok(n) => Tok::Num(n),
                    Err(_) => {
                        return Err(LogoError::parse(
                            &format!("{} isn't a number", text),
                            Span::new(ws, i),
                        ))
                    }
                }
            }
            _ if is_word_char(c) => {
                let ws = i;
                while i < bytes.len() && is_word_char(src[i..].chars().next().unwrap()) {
                    i += src[i..].chars().next().unwrap().len_utf8();
                }
                Tok::Ident(src[ws..i].to_ascii_lowercase())
            }
            _ => {
                return Err(LogoError::parse(
                    &format!("unexpected character '{}'", c),
                    Span::new(i, i + c.len_utf8()),
                ));
            }
        };
        prev_significant = Some(bytes[i.saturating_sub(1)]);
        tokens.push(Token {
            tok,
            span: Span::new(start, i),
            line,
        });
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<Tok> {
        lex(src).unwrap().into_iter().map(|t| t.tok).collect()
    }

    #[test]
    fn words_vars_numbers() {
        let t = kinds(r#"fd 10.5 make "Colour :size"#);
        assert!(matches!(&t[0], Tok::Ident(s) if s == "fd"));
        assert!(matches!(t[1], Tok::Num(n) if n == 10.5));
        assert!(matches!(&t[2], Tok::Ident(s) if s == "make"));
        assert!(matches!(&t[3], Tok::Word(s) if s == "Colour")); // case preserved
        assert!(matches!(&t[4], Tok::Var(s) if s == "size"));
    }

    #[test]
    fn comments_and_lines() {
        let toks = lex("fd 1 ; comment [ not tokens\nrt 2").unwrap();
        assert_eq!(toks.len(), 4);
        assert_eq!(toks[0].line, 1);
        assert_eq!(toks[2].line, 2);
        assert!(matches!(&toks[2].tok, Tok::Ident(s) if s == "rt"));
    }

    #[test]
    fn unary_minus_matrix() {
        // fd -10       → unary (space before, glued after)
        assert!(matches!(kinds("fd -10")[1], Tok::Minus { unary: true }));
        // :a - 5       → infix (space both sides)
        assert!(matches!(kinds(":a - 5")[1], Tok::Minus { unary: false }));
        // :a -5        → unary (starts the next operand)
        assert!(matches!(kinds(":a -5")[1], Tok::Minus { unary: true }));
        // :a-5         → infix (glued to the operand before)
        assert!(matches!(kinds(":a-5")[1], Tok::Minus { unary: false }));
        // (-5)         → unary (after an opener)
        assert!(matches!(kinds("(-5)")[1], Tok::Minus { unary: true }));
        // [-5]         → unary
        assert!(matches!(kinds("[-5]")[1], Tok::Minus { unary: true }));
        // 3 * -2       → unary (after an operator)
        assert!(matches!(kinds("3 * -2")[2], Tok::Minus { unary: true }));
        // 3-2          → infix
        assert!(matches!(kinds("3-2")[1], Tok::Minus { unary: false }));
    }

    #[test]
    fn two_char_operators() {
        let t = kinds("1 <= 2 >= 3 <> 4 < 5 > 6");
        assert!(matches!(t[1], Tok::Le));
        assert!(matches!(t[3], Tok::Ge));
        assert!(matches!(t[5], Tok::Ne));
        assert!(matches!(t[7], Tok::Lt));
        assert!(matches!(t[9], Tok::Gt));
    }

    #[test]
    fn spans_are_byte_offsets() {
        let toks = lex("fd 10").unwrap();
        assert_eq!((toks[0].span.start, toks[0].span.end), (0, 2));
        assert_eq!((toks[1].span.start, toks[1].span.end), (3, 5));
    }

    #[test]
    fn predicates_and_template_var() {
        let t = kinds("empty? ?");
        assert!(matches!(&t[0], Tok::Ident(s) if s == "empty?"));
        assert!(matches!(&t[1], Tok::Ident(s) if s == "?"));
    }

    #[test]
    fn quoted_word_ends_at_delimiter() {
        let t = kinds(r#"if empty? "x ["end]"#);
        assert!(matches!(&t[2], Tok::Word(s) if s == "x"));
        assert!(matches!(&t[4], Tok::Word(s) if s == "end"));
        assert!(matches!(t[5], Tok::RBracket));
    }

    #[test]
    fn exponent_numbers() {
        assert!(matches!(kinds("1e3")[0], Tok::Num(n) if n == 1000.0));
        assert!(matches!(kinds("2.5e-2")[0], Tok::Num(n) if n == 0.025));
        // 'e' alone stays a word: `2 e` is a number then ident
        let t = kinds("2 e");
        assert!(matches!(t[0], Tok::Num(_)));
        assert!(matches!(&t[1], Tok::Ident(s) if s == "e"));
    }
}
