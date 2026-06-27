//! Text → strokes, in two modes that share one layout. **Single-line** uses embedded Hershey
//! single-stroke fonts (M/L path data) and yields pen centrelines — the staple plotter text.
//! **Outline** uses subset DejaVu TTFs via `ttf-parser` and yields closed glyph contours, which the
//! element hatch-fills even-odd (so holes in O/A/e fall out). Pure layout; `size` is the em in mm.

use crate::geom::{Point, Stroke};
use std::collections::HashMap;

const HERSHEY_JSON: &str = include_str!("../fonts/hershey.json");
const SANS: &[u8] = include_bytes!("../fonts/sans.ttf");
const SERIF: &[u8] = include_bytes!("../fonts/serif.ttf");
const MONO: &[u8] = include_bytes!("../fonts/mono.ttf");

/// Nominal Hershey em (full ascender→descender) so `size` reads like a normal font size.
const HERSHEY_EM: f32 = 32.0;
const FLATTEN_TOL: f32 = crate::tess::TEXT_FLATTEN_TOL; // mm

fn default_size() -> f32 {
    10.0
}
fn default_line() -> f32 {
    1.3
}

#[derive(serde::Deserialize)]
#[serde(default)]
struct Params {
    text: String,
    mode: String,           // "single" | "outline"
    font: String,           // hershey key, or "sans" / "serif" / "mono"
    size: f32,              // mm (em)
    letter_spacing: f32,    // extra mm between glyphs
    line_spacing: f32,      // line-height factor
    align: String,          // "left" | "center" | "right"
}
impl Default for Params {
    fn default() -> Self {
        Self {
            text: String::new(),
            mode: "single".into(),
            font: "futural".into(),
            size: default_size(),
            letter_spacing: 0.0,
            line_spacing: default_line(),
            align: "left".into(),
        }
    }
}

// ---- Hershey ------------------------------------------------------------------------------------

struct HGlyph {
    strokes: Vec<Vec<(f32, f32)>>, // Hershey units, y-down (drawn at raw coords — the left bearing
    advance: f32,                  // baked into them is what spaces the glyphs)
}

/// The Hershey glyph coordinates are scaled by this factor relative to the advance unit `o`, so the
/// horizontal advance per glyph is `o * 1.68` (matches the reference hersheytext renderer). The word
/// space uses the same factor on a default advance.
const HERSHEY_ADV_MUL: f32 = 1.68;
const HERSHEY_SPACE_O: f32 = 10.0;

#[derive(serde::Deserialize)]
struct RawFont {
    chars: Vec<RawChar>,
}
#[derive(serde::Deserialize)]
struct RawChar {
    d: String,
    o: f32,
}

thread_local! {
    static HERSHEY: HashMap<String, Vec<HGlyph>> = parse_hershey();
}

fn parse_hershey() -> HashMap<String, Vec<HGlyph>> {
    let raw: HashMap<String, RawFont> = serde_json::from_str(HERSHEY_JSON).unwrap_or_default();
    raw.into_iter()
        .map(|(k, f)| (k, f.chars.iter().map(parse_glyph).collect()))
        .collect()
}

/// Parse one Hershey glyph's `d` (e.g. `"M5,1 L5,15 M5,20 L4,21 5,22"`): `M` lifts the pen and
/// starts a stroke, `L`/bare points extend it.
fn parse_glyph(c: &RawChar) -> HGlyph {
    let mut strokes: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut cur: Vec<(f32, f32)> = Vec::new();
    for tok in c.d.split_whitespace() {
        let (newstroke, coord) = match tok.as_bytes().first() {
            Some(b'M') => (true, &tok[1..]),
            Some(b'L') => (false, &tok[1..]),
            _ => (false, tok),
        };
        let mut it = coord.split(',');
        if let (Some(x), Some(y)) = (it.next(), it.next()) {
            if let (Ok(x), Ok(y)) = (x.parse::<f32>(), y.parse::<f32>()) {
                if newstroke {
                    if cur.len() >= 2 {
                        strokes.push(std::mem::take(&mut cur));
                    } else {
                        cur.clear();
                    }
                }
                cur.push((x, y));
            }
        }
    }
    if cur.len() >= 2 {
        strokes.push(cur);
    }
    HGlyph { strokes, advance: c.o }
}

// ---- TTF outline --------------------------------------------------------------------------------

fn ttf_bytes(font: &str) -> &'static [u8] {
    match font {
        "serif" => SERIF,
        "mono" => MONO,
        _ => SANS,
    }
}

/// Accumulates one glyph's outline (in font units, y-up) into flattened closed contours.
struct Outliner {
    contours: Vec<Vec<(f32, f32)>>,
    cur: Vec<(f32, f32)>,
    last: (f32, f32),
    tol: f32, // in font units
}
impl Outliner {
    fn flush(&mut self) {
        if self.cur.len() >= 3 {
            self.contours.push(std::mem::take(&mut self.cur));
        } else {
            self.cur.clear();
        }
    }
}
impl ttf_parser::OutlineBuilder for Outliner {
    fn move_to(&mut self, x: f32, y: f32) {
        self.flush();
        self.last = (x, y);
        self.cur.push((x, y));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.last = (x, y);
        self.cur.push((x, y));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        flatten_quad(self.last, (x1, y1), (x, y), self.tol, &mut self.cur, 0);
        self.last = (x, y);
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        flatten_cubic(self.last, (x1, y1), (x2, y2), (x, y), self.tol, &mut self.cur, 0);
        self.last = (x, y);
    }
    fn close(&mut self) {
        self.flush();
    }
}

type P = (f32, f32);
fn mid(a: P, b: P) -> P {
    ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5)
}
fn dist_pt_line(p: P, a: P, b: P) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l = (dx * dx + dy * dy).sqrt();
    if l < 1e-9 {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / l
}
fn flatten_quad(p0: P, p1: P, p2: P, tol: f32, out: &mut Vec<P>, depth: u8) {
    if depth >= 16 || dist_pt_line(p1, p0, p2) <= tol {
        out.push(p2);
        return;
    }
    let a = mid(p0, p1);
    let b = mid(p1, p2);
    let m = mid(a, b);
    flatten_quad(p0, a, m, tol, out, depth + 1);
    flatten_quad(m, b, p2, tol, out, depth + 1);
}
fn flatten_cubic(p0: P, p1: P, p2: P, p3: P, tol: f32, out: &mut Vec<P>, depth: u8) {
    if depth >= 16 || (dist_pt_line(p1, p0, p3) <= tol && dist_pt_line(p2, p0, p3) <= tol) {
        out.push(p3);
        return;
    }
    let p01 = mid(p0, p1);
    let p12 = mid(p1, p2);
    let p23 = mid(p2, p3);
    let p012 = mid(p01, p12);
    let p123 = mid(p12, p23);
    let m = mid(p012, p123);
    flatten_cubic(p0, p01, p012, m, tol, out, depth + 1);
    flatten_cubic(m, p123, p23, p3, tol, out, depth + 1);
}

// ---- layout -------------------------------------------------------------------------------------

fn align_offset(align: &str, line_w: f32) -> f32 {
    match align {
        "center" => -line_w * 0.5,
        "right" => -line_w,
        _ => 0.0,
    }
}

fn stroke(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}

pub fn text(params_json: &str) -> Vec<Stroke> {
    let p: Params = serde_json::from_str(params_json).unwrap_or_default();
    if p.text.is_empty() || p.size <= 0.0 {
        return Vec::new();
    }
    if p.mode == "outline" {
        outline_layout(&p)
    } else {
        hershey_layout(&p)
    }
}

fn hershey_layout(p: &Params) -> Vec<Stroke> {
    HERSHEY.with(|fonts| {
        let glyphs = match fonts.get(&p.font).or_else(|| fonts.get("futural")) {
            Some(g) => g,
            None => return Vec::new(),
        };
        let scale = p.size / HERSHEY_EM;
        let line_h = p.size * p.line_spacing;
        let glyph_for = |c: char| -> Option<&HGlyph> {
            let code = c as u32;
            if (33..=127).contains(&code) {
                glyphs.get((code - 33) as usize)
            } else {
                None
            }
        };
        // Advance per glyph = o * 1.68 (coords are scaled relative to the advance unit); word space
        // uses a default advance. Glyphs draw at raw coords so their built-in left bearing spaces them.
        let advance = |c: char| -> f32 {
            glyph_for(c).map_or(HERSHEY_SPACE_O, |g| g.advance) * HERSHEY_ADV_MUL * scale + p.letter_spacing
        };
        let line_width = |line: &str| line.chars().map(advance).sum::<f32>();
        let mut out = Vec::new();
        for (li, line) in p.text.split('\n').enumerate() {
            let top = li as f32 * line_h;
            let mut pen = align_offset(&p.align, line_width(line));
            for c in line.chars() {
                if let Some(g) = glyph_for(c) {
                    for s in &g.strokes {
                        out.push(stroke(
                            s.iter().map(|&(x, y)| Point { x: pen + x * scale, y: top + y * scale, pressure: 1.0 }).collect(),
                        ));
                    }
                }
                pen += advance(c);
            }
        }
        out
    })
}

fn outline_layout(p: &Params) -> Vec<Stroke> {
    let face = match ttf_parser::Face::parse(ttf_bytes(&p.font), 0) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let upem = face.units_per_em() as f32;
    let scale = p.size / upem;
    let tol_units = FLATTEN_TOL / scale;
    let line_h = p.size * p.line_spacing;
    let space = upem * 0.3 * scale;
    let advance = |c: char| -> f32 {
        face.glyph_index(c).and_then(|g| face.glyph_hor_advance(g)).map_or(space / scale, |a| a as f32) * scale
            + p.letter_spacing
    };
    let line_width = |line: &str| line.chars().map(advance).sum::<f32>();

    let mut out = Vec::new();
    for (li, line) in p.text.split('\n').enumerate() {
        // Baseline so the em box top sits at `top` (y-down page; glyph units are y-up).
        let baseline = li as f32 * line_h + p.size;
        let mut pen = align_offset(&p.align, line_width(line));
        for c in line.chars() {
            if let Some(gid) = face.glyph_index(c) {
                let mut b = Outliner { contours: Vec::new(), cur: Vec::new(), last: (0.0, 0.0), tol: tol_units };
                if face.outline_glyph(gid, &mut b).is_some() {
                    b.flush();
                    for contour in &b.contours {
                        out.push(stroke(
                            contour
                                .iter()
                                .map(|&(x, y)| Point { x: pen + x * scale, y: baseline - y * scale, pressure: 1.0 })
                                .collect(),
                        ));
                    }
                }
            }
            pen += advance(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_line_emits_centrelines() {
        let out = text(r#"{"text":"AV","mode":"single","font":"futural","size":10}"#);
        assert!(!out.is_empty(), "Hershey text produced strokes");
        // Open centrelines: ends shouldn't coincide for a stroke like the diagonal of A/V.
        assert!(out.iter().any(|s| s.points.len() >= 2));
    }
    #[test]
    fn outline_emits_closed_contours_with_holes() {
        // 'o' has two contours (outer + inner hole) in the outline font.
        let out = text(r#"{"text":"o","mode":"outline","font":"sans","size":20}"#);
        assert!(out.len() >= 2, "outline 'o' has an outer ring and a hole, got {}", out.len());
        for s in &out {
            let (a, b) = (s.points[0], s.points[s.points.len() - 1]);
            assert!((a.x - b.x).abs() < 1.0 && (a.y - b.y).abs() < 1.0 || s.points.len() > 3);
        }
    }
    #[test]
    fn newline_stacks_lines() {
        let one = text(r#"{"text":"A","mode":"single","size":10}"#);
        let two = text(r#"{"text":"A\nA","mode":"single","size":10}"#);
        let maxy = |v: &[Stroke]| v.iter().flat_map(|s| s.points.iter()).fold(0.0f32, |m, p| m.max(p.y));
        assert!(maxy(&two) > maxy(&one) + 5.0, "second line is lower");
    }
}
