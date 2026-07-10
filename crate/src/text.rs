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
    mode: String,        // "single" | "outline"
    font: String,        // hershey key, or "sans" / "serif" / "mono"
    size: f32,           // mm (em)
    letter_spacing: f32, // extra mm between glyphs
    line_spacing: f32,   // line-height factor
    align: String,       // "left" | "center" | "right" | "justify"
    max_width: f32,      // wrap width in mm; 0 = no wrap (lines break only on '\n')
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
            max_width: 0.0,
        }
    }
}

// ---- Hershey ------------------------------------------------------------------------------------

struct HGlyph {
    strokes: Vec<Vec<(f32, f32)>>, // Hershey units, y-down, left bearing at x=0
    advance: f32,                  // true JHF advance (right - left), Hershey units
}

#[derive(serde::Deserialize)]
struct RawFont {
    chars: Vec<RawChar>,
}
#[derive(serde::Deserialize)]
struct RawChar {
    d: String,
    /// True horizontal advance in Hershey units (JHF right − left), emitted by tools/gen_hershey.py.
    a: f32,
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
    HGlyph {
        strokes,
        advance: c.a,
    }
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
        flatten_cubic(
            self.last,
            (x1, y1),
            (x2, y2),
            (x, y),
            self.tol,
            &mut self.cur,
            0,
        );
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
//
// One paragraph layouter drives both modes: it tokenizes a `\n`-delimited paragraph into words
// (with the space runs between them kept as counted gaps, so `"a  b"` stays two spaces wide),
// breaks greedily at `max_width` (0 = no wrap), and resolves alignment — including justify, which
// stretches inter-word gaps on wrap-broken ("soft") lines only. Advances are prev-aware so kerning
// feeds measurement, not just placement. The same numbers are used to measure and to emit, so
// alignment can never disagree with the ink.

/// One word: its chars, measured width, and the number of spaces preceding it.
struct Tok {
    chars: Vec<char>,
    width: f32,
    gap: u32,
}

/// A broken line: token range, ink width (leading indent + words + internal gaps), the justify
/// denominator (spaces in internal gaps), and whether the break was wrap-induced (soft).
struct Line {
    start: usize,
    end: usize,
    width: f32,
    gap_spaces: u32,
    soft: bool,
}

/// Lay out one paragraph, calling `emit(line_index, pen_x, c)` for every char at its resolved
/// position (`line_index` is absolute, starting at `li0`). Returns the number of lines used.
///
/// `adv(next, c)` is the advance consumed by `c` given the char that follows it in the word
/// (None at a word end) — the kern pair (c, next) belongs to c's advance, so kerning shifts
/// `next` and everything after it, in measurement and placement alike.
fn layout_paragraph(
    para: &str,
    li0: usize,
    p: &Params,
    adv: &mut dyn FnMut(Option<char>, char) -> f32,
    emit: &mut dyn FnMut(usize, f32, char),
) -> usize {
    let space_w = adv(None, ' ');

    // Tokenize into words + counted gaps (trailing spaces kept for unwrapped alignment).
    let mut toks: Vec<Tok> = Vec::new();
    let mut gap = 0u32;
    for c in para.chars() {
        if c == ' ' {
            gap += 1;
            continue;
        }
        if toks.is_empty() || gap > 0 {
            toks.push(Tok {
                chars: Vec::new(),
                width: 0.0,
                gap,
            });
            gap = 0;
        }
        toks.last_mut().unwrap().chars.push(c);
    }
    let trailing = gap;
    if toks.is_empty() {
        return 1; // blank line: consumes vertical space, draws nothing
    }
    for t in &mut toks {
        t.width = t
            .chars
            .iter()
            .enumerate()
            .map(|(i, &c)| adv(t.chars.get(i + 1).copied(), c))
            .sum();
    }

    // Greedy break. Unwrapped: one line whose width includes the trailing spaces (so center/right
    // alignment matches a per-char walk). The first line keeps the paragraph's leading spaces as
    // an indent; wrap-started lines drop their leading gap.
    let wrap = p.max_width > 0.0;
    let mut lines: Vec<Line> = Vec::new();
    if !wrap {
        let width = toks
            .iter()
            .map(|t| t.gap as f32 * space_w + t.width)
            .sum::<f32>()
            + trailing as f32 * space_w;
        let gap_spaces = toks.iter().skip(1).map(|t| t.gap).sum();
        lines.push(Line {
            start: 0,
            end: toks.len(),
            width,
            gap_spaces,
            soft: false,
        });
    } else {
        let mut cur = Line {
            start: 0,
            end: 0,
            width: 0.0,
            gap_spaces: 0,
            soft: false,
        };
        for (i, t) in toks.iter().enumerate() {
            let lead = if i == cur.start {
                if cur.start == 0 {
                    t.gap as f32 * space_w
                } else {
                    0.0
                }
            } else {
                t.gap as f32 * space_w
            };
            if i > cur.start && cur.width + lead + t.width > p.max_width {
                cur.end = i;
                cur.soft = true; // broken by wrap, not by paragraph end
                lines.push(cur);
                cur = Line {
                    start: i,
                    end: i,
                    width: t.width,
                    gap_spaces: 0,
                    soft: false,
                };
            } else {
                if i > cur.start {
                    cur.gap_spaces += t.gap;
                }
                cur.width += lead + t.width;
            }
        }
        cur.end = toks.len();
        lines.push(cur);
    }

    // Resolve alignment and emit. When wrapping, center/right align within the wrap box; when not,
    // they hang off the anchor exactly as before (x = -w/2 / -w). Justify = left + stretched gaps,
    // on soft lines only.
    for (lli, line) in lines.iter().enumerate() {
        let (x0, extra_per_space) = match p.align.as_str() {
            "center" => (
                if wrap {
                    (p.max_width - line.width) * 0.5
                } else {
                    -line.width * 0.5
                },
                0.0,
            ),
            "right" => (
                if wrap {
                    p.max_width - line.width
                } else {
                    -line.width
                },
                0.0,
            ),
            "justify" if line.soft && line.gap_spaces > 0 => {
                (0.0, (p.max_width - line.width) / line.gap_spaces as f32)
            }
            _ => (0.0, 0.0),
        };
        let li = li0 + lli;
        let mut pen = x0;
        for (i, t) in toks[line.start..line.end].iter().enumerate() {
            if i == 0 {
                // Leading indent only on the paragraph's own first line; wrapped lines start flush.
                if line.start == 0 {
                    pen += t.gap as f32 * space_w;
                }
            } else {
                pen += t.gap as f32 * (space_w + extra_per_space);
            }
            for (ci, &c) in t.chars.iter().enumerate() {
                emit(li, pen, c);
                pen += adv(t.chars.get(ci + 1).copied(), c);
            }
        }
    }
    lines.len()
}

// ---- GPOS pair kerning (outline mode) ------------------------------------------------------------

/// The GPOS PairPos subtables of a face, collected once per layout. Only pair adjustment is read
/// (formats 1 and 2, first match wins, `x_advance` of the first glyph's value record) — the bundled
/// subsets carry essentially only kern data, and extension lookups are unwrapped by ttf-parser.
struct KernTable<'a> {
    pairs: Vec<ttf_parser::gpos::PairAdjustment<'a>>,
}

impl<'a> KernTable<'a> {
    fn new(face: &ttf_parser::Face<'a>) -> Self {
        let mut pairs = Vec::new();
        if let Some(gpos) = face.tables().gpos {
            for li in 0..gpos.lookups.len() {
                let Some(lookup) = gpos.lookups.get(li) else {
                    continue;
                };
                for si in 0..lookup.subtables.len() {
                    if let Some(ttf_parser::gpos::PositioningSubtable::Pair(pa)) =
                        lookup
                            .subtables
                            .get::<ttf_parser::gpos::PositioningSubtable>(si)
                    {
                        pairs.push(pa);
                    }
                }
            }
        }
        Self { pairs }
    }

    /// Kern adjustment between two glyphs in font units (typically negative for pairs like AV).
    fn kern(&self, left: ttf_parser::GlyphId, right: ttf_parser::GlyphId) -> f32 {
        use ttf_parser::gpos::PairAdjustment;
        for pa in &self.pairs {
            match pa {
                PairAdjustment::Format1 { coverage, sets } => {
                    if let Some(idx) = coverage.get(left) {
                        if let Some((v, _)) = sets.get(idx).and_then(|s| s.get(right)) {
                            return v.x_advance as f32;
                        }
                    }
                }
                PairAdjustment::Format2 {
                    coverage,
                    classes,
                    matrix,
                } => {
                    if coverage.get(left).is_some() {
                        if let Some((v, _)) =
                            matrix.get((classes.0.get(left), classes.1.get(right)))
                        {
                            return v.x_advance as f32;
                        }
                    }
                }
            }
        }
        0.0
    }
}

fn stroke(points: Vec<Point>) -> Stroke {
    Stroke {
        points,
        pen: 0,
        reversible: true,
        group: 0,
    }
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
            if (32..=127).contains(&code) {
                glyphs.get((code - 32) as usize)
            } else {
                None
            }
        };
        // True JHF advances; an unmapped char takes the space advance (glyph 0).
        let space_adv = glyphs.first().map_or(16.0, |g| g.advance);
        let mut adv = |_next: Option<char>, c: char| {
            glyph_for(c).map_or(space_adv, |g| g.advance) * scale + p.letter_spacing
        };

        let mut out = Vec::new();
        let mut emit = |li: usize, pen: f32, c: char| {
            let top = li as f32 * line_h;
            if let Some(g) = glyph_for(c) {
                for s in &g.strokes {
                    out.push(stroke(
                        s.iter()
                            .map(|&(x, y)| Point {
                                x: pen + x * scale,
                                y: top + y * scale,
                                pressure: 1.0,
                            })
                            .collect(),
                    ));
                }
            }
        };
        let mut li = 0;
        for para in p.text.split('\n') {
            li += layout_paragraph(para, li, p, &mut adv, &mut emit);
        }
        out
    })
}

fn outline_layout(p: &Params) -> Vec<Stroke> {
    let face = match ttf_parser::Face::parse(ttf_bytes(&p.font), 0) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let kern = KernTable::new(&face);
    let upem = face.units_per_em() as f32;
    let scale = p.size / upem;
    let tol_units = FLATTEN_TOL / scale;
    let line_h = p.size * p.line_spacing;
    let space = upem * 0.3;
    // The pair kern (c, next) belongs to c's advance, shifting `next` and everything after it —
    // and it's inside measurement, so wrap and alignment see the kerned widths.
    let mut adv = |next: Option<char>, c: char| -> f32 {
        let gid = face.glyph_index(c);
        let a = gid
            .and_then(|g| face.glyph_hor_advance(g))
            .map_or(space, |a| a as f32);
        let k = match (gid, next.and_then(|nc| face.glyph_index(nc))) {
            (Some(l), Some(r)) => kern.kern(l, r),
            _ => 0.0,
        };
        (a + k) * scale + p.letter_spacing
    };

    let mut out = Vec::new();
    let mut emit = |li: usize, pen: f32, c: char| {
        // Baseline so the em box top sits at the line top (y-down page; glyph units are y-up).
        let baseline = li as f32 * line_h + p.size;
        if let Some(gid) = face.glyph_index(c) {
            let mut b = Outliner {
                contours: Vec::new(),
                cur: Vec::new(),
                last: (0.0, 0.0),
                tol: tol_units,
            };
            if face.outline_glyph(gid, &mut b).is_some() {
                b.flush();
                for contour in &b.contours {
                    out.push(stroke(
                        contour
                            .iter()
                            .map(|&(x, y)| Point {
                                x: pen + x * scale,
                                y: baseline - y * scale,
                                pressure: 1.0,
                            })
                            .collect(),
                    ));
                }
            }
        }
    };
    let mut li = 0;
    for para in p.text.split('\n') {
        li += layout_paragraph(para, li, p, &mut adv, &mut emit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn max_x(v: &[Stroke]) -> f32 {
        v.iter()
            .flat_map(|s| s.points.iter())
            .fold(f32::MIN, |m, p| m.max(p.x))
    }
    fn max_y(v: &[Stroke]) -> f32 {
        v.iter()
            .flat_map(|s| s.points.iter())
            .fold(f32::MIN, |m, p| m.max(p.y))
    }

    #[test]
    fn single_line_emits_centrelines() {
        let out = text(r#"{"text":"AV","mode":"single","font":"futural","size":10}"#);
        assert!(!out.is_empty(), "Hershey text produced strokes");
        // Open centrelines: ends shouldn't coincide for a stroke like the diagonal of A/V.
        assert!(out.iter().any(|s| s.points.len() >= 2));
    }

    #[test]
    fn hershey_advances_are_proportional() {
        HERSHEY.with(|fonts| {
            let g = &fonts["futural"];
            let adv = |c: char| g[(c as usize) - 32].advance;
            assert!(
                adv('i') < adv('m'),
                "i ({}) narrower than m ({})",
                adv('i'),
                adv('m')
            );
            assert!(adv(' ') > 0.0, "space has a real advance");
        });
    }

    #[test]
    fn runs_of_spaces_keep_their_width() {
        let one = text(r#"{"text":"i i","mode":"single","size":10}"#);
        let two = text(r#"{"text":"i  i","mode":"single","size":10}"#);
        let space_mm = HERSHEY.with(|f| f["futural"][0].advance) * 10.0 / HERSHEY_EM;
        let d = max_x(&two) - max_x(&one);
        assert!(
            (d - space_mm).abs() < 1e-4,
            "extra space advanced by {d}, want {space_mm}"
        );
    }

    #[test]
    fn wrap_breaks_at_word_boundaries() {
        let flat = text(r#"{"text":"mmm mmm mmm mmm","mode":"single","size":10}"#);
        let wrapped =
            text(r#"{"text":"mmm mmm mmm mmm","mode":"single","size":10,"max_width":40}"#);
        assert!(
            max_y(&wrapped) > max_y(&flat) + 5.0,
            "wrapping stacked lines"
        );
        assert!(
            max_x(&wrapped) <= 40.0,
            "no line overflows the wrap width (ink {} mm)",
            max_x(&wrapped)
        );
    }

    #[test]
    fn hard_breaks_survive_wrapping() {
        let soft = text(r#"{"text":"ii ii","mode":"single","size":10,"max_width":200}"#);
        let hard = text(r#"{"text":"ii\n\nii","mode":"single","size":10,"max_width":200}"#);
        assert!(
            max_y(&hard) > max_y(&soft) + 20.0,
            "explicit newlines (incl. blank line) still break"
        );
    }

    #[test]
    fn justify_stretches_soft_lines_to_the_wrap_width() {
        // 'm' is 9.375 mm at size 10; "mmm mmm" = 61.25 mm, so 65 mm fits two words per line.
        let base = r#""text":"mmm mmm mmm mm","mode":"single","size":10,"max_width":65"#;
        let left = text(&format!("{{{base},\"align\":\"left\"}}"));
        let just = text(&format!("{{{base},\"align\":\"justify\"}}"));
        assert!(
            (max_y(&left) - max_y(&just)).abs() < 1e-4,
            "same line breaks"
        );
        assert!(
            max_x(&just) > max_x(&left) + 1.0,
            "soft line gaps stretched"
        );
        assert!(
            max_x(&just) <= 65.0 && max_x(&just) > 65.0 * 0.85,
            "fills the box (ink {} mm)",
            max_x(&just)
        );
    }

    #[test]
    fn kerning_present_in_proportional_fonts_only() {
        for (font, kerned) in [("sans", true), ("serif", true), ("mono", false)] {
            let face = ttf_parser::Face::parse(ttf_bytes(font), 0).unwrap();
            let kern = KernTable::new(&face);
            let a = face.glyph_index('A').unwrap();
            let v = face.glyph_index('V').unwrap();
            let k = kern.kern(a, v);
            if kerned {
                assert!(k < 0.0, "{font}: AV kern should be negative, got {k}");
            } else {
                assert_eq!(k, 0.0, "{font}: monospace must not kern");
            }
        }
    }

    #[test]
    fn kerning_tightens_outline_text() {
        let av = text(r#"{"text":"AV","mode":"outline","font":"sans","size":20}"#);
        let aa = text(r#"{"text":"AA","mode":"outline","font":"sans","size":20}"#);
        // Same first glyph; AV kerns negative while AA doesn't, so AV's ink ends earlier.
        assert!(
            max_x(&av) < max_x(&aa),
            "AV ({}) tighter than AA ({})",
            max_x(&av),
            max_x(&aa)
        );
    }
    #[test]
    fn outline_emits_closed_contours_with_holes() {
        // 'o' has two contours (outer + inner hole) in the outline font.
        let out = text(r#"{"text":"o","mode":"outline","font":"sans","size":20}"#);
        assert!(
            out.len() >= 2,
            "outline 'o' has an outer ring and a hole, got {}",
            out.len()
        );
        for s in &out {
            let (a, b) = (s.points[0], s.points[s.points.len() - 1]);
            assert!((a.x - b.x).abs() < 1.0 && (a.y - b.y).abs() < 1.0 || s.points.len() > 3);
        }
    }
    #[test]
    fn newline_stacks_lines() {
        let one = text(r#"{"text":"A","mode":"single","size":10}"#);
        let two = text(r#"{"text":"A\nA","mode":"single","size":10}"#);
        let maxy = |v: &[Stroke]| {
            v.iter()
                .flat_map(|s| s.points.iter())
                .fold(0.0f32, |m, p| m.max(p.y))
        };
        assert!(maxy(&two) > maxy(&one) + 5.0, "second line is lower");
    }
}
