//! Text substitution for handwriting: remap out-of-alphabet characters to the nearest in-alphabet
//! glyph (the model's 73-char alphabet omits uppercase Q/X/Z and most punctuation) and report what
//! changed. Shared by `clean_text` (cleaned text → split into words by the worker) and
//! `substitution_note` (the UI warning). Word generation + page layout happen elsewhere.

use crate::model::ALPHABET;

/// Map a character the model can't draw to its nearest in-alphabet stand-in, or `None` to drop it.
/// Returns `Some(c)` unchanged when `c` is already in the alphabet.
fn map_char(c: char) -> Option<char> {
    if ALPHABET.contains(c) {
        return Some(c);
    }
    let r = match c {
        // Uppercase letters the model lacks → lowercase (preserves letter identity).
        'Q' => 'q',
        'X' => 'x',
        'Z' => 'z',
        // Typographic punctuation → ASCII equivalents.
        '\u{2018}' | '\u{2019}' | '\u{2032}' | '`' => '\'', // ‘ ’ ′ `
        '\u{201C}' | '\u{201D}' | '\u{2033}' => '"',         // “ ” ″
        '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',         // – — −
        '\u{2026}' => '.',                                   // …
        '\u{00A0}' => ' ',                                   // nbsp
        // Common Latin-1 accents → base letter.
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ê' | 'ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' => 'o',
        'ú' | 'ù' | 'û' | 'ü' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        // Anything else we can't represent → a visible placeholder.
        _ if !c.is_control() => '?',
        _ => return None,
    };
    Some(r)
}

/// Substitute the text and collect a note like `“Q→q, ’→'”`. Newlines and tabs pass through
/// (handled by the wrapper); tabs become spaces.
pub fn substitute(text: &str) -> (String, String) {
    let mut out = String::with_capacity(text.len());
    let mut subs: Vec<(char, char)> = Vec::new();
    for c in text.chars() {
        if c == '\n' {
            out.push('\n');
            continue;
        }
        if c == '\t' {
            out.push(' ');
            continue;
        }
        match map_char(c) {
            Some(r) => {
                out.push(r);
                if r != c && !subs.iter().any(|&(o, _)| o == c) {
                    subs.push((c, r));
                }
            }
            None => {
                if !subs.iter().any(|&(o, _)| o == c) {
                    subs.push((c, '∅'));
                }
            }
        }
    }
    let note = subs
        .iter()
        .map(|&(o, r)| if r == '∅' { format!("{o}→(dropped)") } else { format!("{o}→{r}") })
        .collect::<Vec<_>>()
        .join(", ");
    (out, note)
}
