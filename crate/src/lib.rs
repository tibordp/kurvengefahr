//! `kg_core` — all of Kurvengefahr's "fancy" geometry & mark compute, in Rust → WASM. The TS app
//! owns only the UI, view-state and the WASM-boundary marshalling; everything that makes marks or
//! motion is here.
//!
//! WASM entry points:
//!   - `init_model` / `generate_word` — the Graves RNN-MDN handwriting model (one word at a time).
//!   - `clean_text` / `substitution_note` — alphabet substitution (cleaned text + a human note).
//!   - `tessellate_rect/ellipse/path`, `hatch`, `concentric`, `simplify_polyline`, `split_cubic`
//!     — vector shapes, multi-contour paths, even-odd hatch fills, and path-edit helpers.
//!   - `boolean` — polygon booleans (union/intersect/difference/xor) for combining shapes.
//!   - `import_svg` — parse an SVG (usvg) → occluded multi-contour geometry.
//!   - `vectorize_image` — raster → strokes (outline/hatch/TSP/flow/spiral/…).
//!   - `clip` — split strokes to the reachable rectangle.
//!   - `optimize` — reorder strokes (chain-aware, per-pen greedy nearest-neighbour).

mod boolean;
mod cleanup;
mod clip;
mod compose;
mod generative;
mod geom;
mod hatch;
mod model;
mod raster;
mod shapes;
mod svg;
mod text;
mod typeset;

use std::cell::RefCell;

use wasm_bindgen::prelude::*;

use clip::Rect;
use geom::{decode, GeometryBuffers, Stroke};
use model::Model;
use typeset::place_word;

thread_local! {
    /// The handwriting model, loaded once via `init_model`. WASM is single-threaded, so a
    /// thread-local is effectively a module global.
    static MODEL: RefCell<Option<Model>> = const { RefCell::new(None) };
}

/// Load the f16 weight blob (see `tools/convert_weights.py`). Idempotent-friendly: re-loading
/// just replaces the weights. JS fetches the blob lazily and calls this before generating.
#[wasm_bindgen]
pub fn init_model(bytes: &[u8]) -> Result<(), JsValue> {
    let model = Model::load(bytes).map_err(|e| JsValue::from_str(&e))?;
    MODEL.with(|m| *m.borrow_mut() = Some(model));
    Ok(())
}

/// Whether the handwriting model has been loaded.
#[wasm_bindgen]
pub fn model_ready() -> bool {
    MODEL.with(|m| m.borrow().is_some())
}


/// Positioned geometry for one word plus its advance width (mm). Exposes the same flat-buffer
/// getters as `GeometryBuffers` so JS decodes the geometry identically, with `width` read separately
/// for layout.
#[wasm_bindgen]
pub struct WordResult {
    geom: GeometryBuffers,
    width: f32,
}

#[wasm_bindgen]
impl WordResult {
    #[wasm_bindgen(getter)]
    pub fn xy(&self) -> Vec<f32> {
        self.geom.xy()
    }
    #[wasm_bindgen(getter)]
    pub fn pressure(&self) -> Vec<f32> {
        self.geom.pressure()
    }
    #[wasm_bindgen(getter)]
    pub fn offsets(&self) -> Vec<u32> {
        self.geom.offsets()
    }
    #[wasm_bindgen(getter)]
    pub fn pen(&self) -> Vec<u16> {
        self.geom.pen()
    }
    #[wasm_bindgen(getter)]
    pub fn reversible(&self) -> Vec<u8> {
        self.geom.reversible()
    }
    #[wasm_bindgen(getter)]
    pub fn group(&self) -> Vec<u32> {
        self.geom.group()
    }
    /// Advance width in mm (used by the worker to lay words out left→right and wrap).
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> f32 {
        self.width
    }
}

/// Synthesize one already-substituted, space-free `word`, primed on the golden sample for a
/// consistent hand, scaled to `font_size_mm` (+ optional extra `slant_deg`), with its baseline at
/// y=0 and x from 0. The worker places it on the page. Deterministic for `(word, seed, bias)`.
/// Errors if the model isn't loaded.
#[wasm_bindgen]
pub fn generate_word(
    word: &str,
    font_size_mm: f32,
    slant_deg: f32,
    seed: u32,
    bias: f32,
) -> Result<WordResult, JsValue> {
    MODEL.with(|m| {
        let borrow = m.borrow();
        let model = borrow
            .as_ref()
            .ok_or_else(|| JsValue::from_str("handwriting model not loaded"))?;
        let ink = model.generate_word(word, seed, bias);
        Ok(WordResult {
            geom: GeometryBuffers::from_strokes(&place_word(&ink, font_size_mm, slant_deg)),
            width: ink.width * font_size_mm,
        })
    })
}

/// Substitute out-of-alphabet characters, returning the cleaned text (newlines/spaces preserved).
/// The worker splits this into words + line breaks before generating.
#[wasm_bindgen]
pub fn clean_text(text: &str) -> String {
    compose::substitute(text).0
}

/// The character-substitution note for `text` (e.g. `"Q→q, ’→'"`), or empty if every character is
/// in the model's alphabet. Stateless and model-independent, so the UI can warn as the user types.
#[wasm_bindgen]
pub fn substitution_note(text: &str) -> String {
    compose::substitute(text).1
}

/// Vector-shape tessellation. Each returns local-mm strokes the registry's `generate()` decodes
/// like any other geometry; the shape's transform is applied downstream in `place`.
#[wasm_bindgen]
pub fn tessellate_rect(w: f32, h: f32, r: f32) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&shapes::rect(w, h, r))
}

#[wasm_bindgen]
pub fn tessellate_ellipse(rx: f32, ry: f32) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&shapes::ellipse(rx, ry))
}

/// Multi-contour path. `nodes` = 6 f32 per node `[x, y, hinX, hinY, houtX, houtY]` (handles relative
/// to the anchor), concatenated across all contours. `contour_starts` has `ncontours+1` entries in
/// **node units** (contour `c` is `nodes[6*starts[c] .. 6*starts[c+1]]`); `closed[c]` flags whether
/// contour `c` is closed. Returns **one stroke per contour, in order** (an empty stroke for a
/// degenerate contour) so JS can keep its `contours[]` indexing aligned.
#[wasm_bindgen]
pub fn tessellate_path(nodes: &[f32], contour_starts: &[u32], closed: &[u8], tol: f32) -> GeometryBuffers {
    let mut strokes: Vec<Stroke> = Vec::with_capacity(closed.len());
    for c in 0..closed.len() {
        let start = contour_starts[c] as usize * 6;
        let end = contour_starts[c + 1] as usize * 6;
        let one = shapes::path(&nodes[start..end], closed[c] != 0, tol);
        strokes.push(one.into_iter().next().unwrap_or_else(|| Stroke {
            points: Vec::new(),
            pen: 0,
            reversible: true,
            group: 0,
        }));
    }
    GeometryBuffers::from_strokes(&strokes)
}

/// Generate a parametric pattern (spirograph / L-system / Truchet / Voronoi / flow field) into
/// strokes, fit to a width×height box (mm). `params` is JSON; `kind` selects the generator.
/// Deterministic per `seed`.
#[wasm_bindgen]
pub fn generative(params: &str) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&generative::generate(params))
}

/// Lay out text as strokes. `params` is JSON (`{text, mode, font, size, letter_spacing,
/// line_spacing, align}`). mode `single` = Hershey single-stroke centrelines; `outline` = closed
/// glyph contours (the element hatch-fills them even-odd). `size` is the em in mm.
#[wasm_bindgen]
pub fn text(params: &str) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&text::text(params))
}

/// Ramer–Douglas–Peucker simplification of a flat `[x0,y0,…]` polyline (for freehand capture).
#[wasm_bindgen]
pub fn simplify_polyline(xy: &[f32], tol: f32) -> Vec<f32> {
    shapes::simplify(xy, tol)
}

/// Split the cubic between two path nodes at `t` (de Casteljau) for inserting a node mid-segment.
/// See `shapes::split_cubic`; returns 10 floats `[Sx,Sy, aHoutX,aHoutY, mHinX,mHinY, mHoutX,mHoutY,
/// bHinX,bHinY]`.
#[wasm_bindgen]
pub fn split_cubic(
    ax: f32,
    ay: f32,
    a_hout_x: f32,
    a_hout_y: f32,
    b_hin_x: f32,
    b_hin_y: f32,
    bx: f32,
    by: f32,
    t: f32,
) -> Vec<f32> {
    shapes::split_cubic((ax, ay), (a_hout_x, a_hout_y), (b_hin_x, b_hin_y), (bx, by), t).to_vec()
}

/// Hatch fill for one or more closed-polygon rings, filled together under **even-odd parity** so
/// nested rings punch holes. `xy` is all rings' vertices concatenated; `ring_starts` has
/// `nrings+1` entries in **point units** (ring `r` is `xy[2*starts[r] .. 2*starts[r+1]]`). Pattern:
/// 0 lines, 1 cross-hatch, 2 grid, 3 hilbert, 4 concentric.
#[wasm_bindgen]
pub fn hatch(xy: &[f32], ring_starts: &[u32], pattern: u32, spacing: f32, angle_deg: f32) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&hatch::fill(xy, ring_starts, pattern, spacing, angle_deg))
}

/// Concentric rings. `kind 0` = rect (a=w, b=h); `kind 1` = ellipse (a=rx, b=ry).
#[wasm_bindgen]
pub fn concentric(kind: u32, a: f32, b: f32, spacing: f32) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&hatch::concentric(kind, a, b, spacing))
}

/// Boolean op between two multi-contour inputs (flat xy + CSR ring offsets, point units): 0 union,
/// 1 intersect, 2 difference, 3 xor. Returns one stroke per result ring (outer rings + holes), which
/// a path element adopts as its even-odd-filled contours. Inputs interpreted even-odd.
#[wasm_bindgen]
pub fn boolean(
    op: u32,
    subj_xy: &[f32],
    subj_starts: &[u32],
    clip_xy: &[f32],
    clip_starts: &[u32],
) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&boolean::combine(op, subj_xy, subj_starts, clip_xy, clip_starts))
}

/// Import an SVG (raw bytes) into native multi-contour geometry. `params` is JSON
/// (`{ occlude, target_size }`); occlusion subtracts upper filled shapes from those beneath so only
/// visible parts become geometry. Returns CSR rings grouped per output shape, each with its source
/// colour + fill darkness, for the TS side to build `path` elements. usvg parses (no text/fonts).
#[wasm_bindgen]
pub fn import_svg(bytes: &[u8], params: &str) -> svg::SvgImport {
    svg::import(bytes, params)
}

/// Vectorize an RGBA image (JS-decoded, row-major `width*height*4` bytes) into pen strokes, fit to
/// the element's physical box. `params` is the JSON-serialized raster params (the union of every
/// stylization method's knobs — see `src/elements/raster` and `raster::Params`); `params.method`
/// selects the method (outline tracing, hatch, TSP, flow field, spiral, …).
#[wasm_bindgen]
pub fn vectorize_image(rgba: &[u8], width: u32, height: u32, params: &str) -> GeometryBuffers {
    GeometryBuffers::from_strokes(&raster::vectorize(rgba, width, height, params))
}

/// Clip geometry to the reachable rectangle (computed JS-side). Strokes that leave and re-enter
/// are split; pen/reversible/group are preserved so a clipped locked chain stays a chain.
#[wasm_bindgen]
pub fn clip(
    xy: &[f32],
    pressure: &[f32],
    offsets: &[u32],
    pen: &[u16],
    reversible: &[u8],
    group: &[u32],
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
) -> GeometryBuffers {
    let strokes = decode(xy, pressure, offsets, pen, reversible, group);
    let rect = Rect { x0, y0, x1, y1 };
    GeometryBuffers::from_strokes(&clip::clip(&strokes, &rect))
}

/// Greedy nearest-neighbour ordering from `(start_x, start_y)`. The unit of ordering is a
/// *chain*: strokes sharing a nonzero group are one locked, contiguous, fixed-direction unit
/// (the whole handwriting element, internal pen-ups and all); group-0 strokes are free
/// singletons that may be reordered and (if reversible) flipped. Geometry is preserved.
/// `pen_order` is the document's pen palette as a list of pen ids; pen groups are plotted in that
/// order (predictable manual swaps), with any stray pens not in the list appended last.
#[wasm_bindgen]
pub fn optimize(
    xy: &[f32],
    pressure: &[f32],
    offsets: &[u32],
    pen: &[u16],
    reversible: &[u8],
    group: &[u32],
    start_x: f32,
    start_y: f32,
    pen_order: &[u16],
) -> GeometryBuffers {
    let strokes = decode(xy, pressure, offsets, pen, reversible, group);
    // Cleanup first (dedupe / chain / collinear on free strokes), then order to minimise travel.
    let strokes = cleanup::cleanup(&strokes);
    GeometryBuffers::from_strokes(&order_greedy(&strokes, start_x, start_y, pen_order))
}

/// An orderable unit: the indices of the strokes it covers (in plot order), whether it may be
/// flipped, and its entry/exit endpoints. A locked chain spans many strokes and can't flip; a
/// singleton is one stroke that flips iff reversible.
struct Unit {
    strokes: Vec<usize>,
    reversible: bool,
    entry: (f32, f32),
    exit: (f32, f32),
    /// A single closed contour (first point ≈ last): the optimizer may begin at any vertex, so we
    /// travel to the nearest point on the loop and traverse from there back to it.
    closed: bool,
    /// Which pen plots this unit (the pen of its strokes — a unit is single-pen). Ordering keeps
    /// each pen's units contiguous so the job changes pens as few times as possible.
    pen: u16,
}

/// How a chosen unit is emitted: a normal unit (optionally flipped if reversible), or a closed
/// contour rotated to begin at vertex `start`.
#[derive(Clone, Copy)]
enum Pick {
    Flip(bool),
    Closed(usize),
}

/// A free singleton whose first and last points coincide — a closed loop we can re-root anywhere.
fn is_closed(s: &Stroke) -> bool {
    let p = &s.points;
    p.len() >= 4 && dist2((p[0].x, p[0].y), (p[p.len() - 1].x, p[p.len() - 1].y)) < 1e-4
}

/// Rotate a closed contour so it starts (and ends) at vertex `start`. `points` has a duplicate
/// closing point (`last == first`), so there are `len-1` distinct vertices.
fn rotate_closed(s: &Stroke, start: usize) -> Stroke {
    let pts = &s.points;
    let m = pts.len() - 1;
    let mut points = Vec::with_capacity(pts.len());
    for off in 0..m {
        points.push(pts[(start + off) % m]);
    }
    points.push(pts[start]); // re-close at the new start
    Stroke { points, pen: s.pen, reversible: s.reversible, group: s.group }
}

/// Partition strokes into units: contiguous runs of equal nonzero group → one locked chain;
/// every group-0 stroke → its own singleton. (Concatenation emits a group's strokes
/// contiguously, so a single linear scan suffices.)
fn build_units(strokes: &[Stroke]) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut i = 0;
    while i < strokes.len() {
        let g = strokes[i].group;
        if g == 0 || strokes[i].points.is_empty() {
            if !strokes[i].points.is_empty() {
                let pts = &strokes[i].points;
                units.push(Unit {
                    strokes: vec![i],
                    reversible: strokes[i].reversible,
                    entry: (pts[0].x, pts[0].y),
                    exit: (pts[pts.len() - 1].x, pts[pts.len() - 1].y),
                    closed: is_closed(&strokes[i]),
                    pen: strokes[i].pen,
                });
            }
            i += 1;
        } else {
            let mut run = Vec::new();
            while i < strokes.len() && strokes[i].group == g {
                if !strokes[i].points.is_empty() {
                    run.push(i);
                }
                i += 1;
            }
            if let (Some(&first), Some(&last)) = (run.first(), run.last()) {
                let fp = &strokes[first].points;
                let lp = &strokes[last].points;
                units.push(Unit {
                    strokes: run,
                    reversible: false, // a locked chain keeps its writing direction
                    entry: (fp[0].x, fp[0].y),
                    exit: (lp[lp.len() - 1].x, lp[lp.len() - 1].y),
                    closed: false,             // chains are ordered, fixed-direction units
                    pen: strokes[first].pen,   // a chain is single-pen (stamped at concatenation)
                });
            }
        }
    }
    units
}

#[inline]
fn dist2(a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = a.0 - b.0;
    let dy = a.1 - b.1;
    dx * dx + dy * dy
}

fn clone_stroke(s: &Stroke, reverse: bool) -> Stroke {
    let mut points = s.points.clone();
    if reverse {
        points.reverse();
    }
    Stroke {
        points,
        pen: s.pen,
        reversible: s.reversible,
        group: s.group,
    }
}

/// How to reach unit `u` from `cursor`: the pick (flip, or which vertex a closed loop starts at)
/// and its travel cost² from the cursor.
fn reach(u: &Unit, strokes: &[Stroke], cursor: (f32, f32)) -> (Pick, f32) {
    if u.closed {
        // Begin at whichever vertex is nearest the pen.
        let pts = &strokes[u.strokes[0]].points;
        let m = pts.len() - 1;
        let mut bk = 0;
        let mut bc = f32::INFINITY;
        for k in 0..m {
            let d = dist2(cursor, (pts[k].x, pts[k].y));
            if d < bc {
                bc = d;
                bk = k;
            }
        }
        (Pick::Closed(bk), bc)
    } else {
        let from_entry = dist2(cursor, u.entry);
        if u.reversible && dist2(cursor, u.exit) < from_entry {
            (Pick::Flip(true), dist2(cursor, u.exit))
        } else {
            (Pick::Flip(false), from_entry)
        }
    }
}

/// Append a chosen unit to `out` and return the pen's new resting position.
fn emit_unit(u: &Unit, strokes: &[Stroke], pick: Pick, out: &mut Vec<Stroke>) -> (f32, f32) {
    match pick {
        Pick::Closed(start) => {
            let s = &strokes[u.strokes[0]];
            out.push(rotate_closed(s, start));
            (s.points[start].x, s.points[start].y) // loop returns to its start
        }
        // Only singletons are reversible, so a flipped unit is exactly one stroke.
        Pick::Flip(true) => {
            out.push(clone_stroke(&strokes[u.strokes[0]], true));
            u.entry
        }
        Pick::Flip(false) => {
            for &si in &u.strokes {
                out.push(clone_stroke(&strokes[si], false));
            }
            u.exit
        }
    }
}

/// Order strokes to minimise travel, **per pen**: pen changes are manual pauses, so we keep every
/// pen's units contiguous (the change count is then just distinct-pens − 1 — the minimum). Pen
/// groups are plotted in `pen_order` (the document's palette order) so swaps are predictable; only
/// travel *within* a pen is optimised, by greedy nearest-neighbour.
fn order_greedy(strokes: &[Stroke], start_x: f32, start_y: f32, pen_order: &[u16]) -> Vec<Stroke> {
    let units = build_units(strokes);
    let n = units.len();
    let mut used = vec![false; n];
    let mut cursor = (start_x, start_y);
    let mut out: Vec<Stroke> = Vec::with_capacity(strokes.len());

    // Distinct pens actually present, in first-appearance order (the fallback for any pen not named
    // in the palette).
    let mut present: Vec<u16> = Vec::new();
    for u in &units {
        if !present.contains(&u.pen) {
            present.push(u.pen);
        }
    }
    // Plot order = palette order (those present), then any stray present-but-unlisted pens.
    let mut order: Vec<u16> = Vec::new();
    for &p in pen_order {
        if present.contains(&p) && !order.contains(&p) {
            order.push(p);
        }
    }
    for &p in &present {
        if !order.contains(&p) {
            order.push(p);
        }
    }

    for &pen in &order {
        let pen_start = cursor;
        // Greedy nearest-neighbour over this pen's units → an initial sequence.
        let mut seq: Vec<usize> = Vec::new();
        loop {
            let mut best: Option<(usize, Pick, f32)> = None;
            for (i, u) in units.iter().enumerate() {
                if used[i] || u.pen != pen {
                    continue;
                }
                let (pick, cost) = reach(u, strokes, cursor);
                if best.map_or(true, |(_, _, bc)| cost < bc) {
                    best = Some((i, pick, cost));
                }
            }
            let (idx, pick, _) = match best {
                Some(b) => b,
                None => break,
            };
            used[idx] = true;
            cursor = unit_exit(&units[idx], strokes, pick);
            seq.push(idx);
        }
        // Refine with Or-opt (relocate single units), then emit the result from the pen's start.
        let seq = or_opt(seq, &units, strokes, pen_start);
        cursor = pen_start;
        for idx in seq {
            let (pick, _) = reach(&units[idx], strokes, cursor);
            cursor = emit_unit(&units[idx], strokes, pick, &mut out);
        }
    }

    out
}

/// The pen's resting position after a unit is plotted with `pick` (without emitting it).
fn unit_exit(u: &Unit, strokes: &[Stroke], pick: Pick) -> (f32, f32) {
    match pick {
        Pick::Closed(start) => {
            let p = &strokes[u.strokes[0]].points[start];
            (p.x, p.y)
        }
        Pick::Flip(true) => u.entry,
        Pick::Flip(false) => u.exit,
    }
}

/// Or-opt: relocate one unit at a time to its best position, re-choosing each unit's orientation
/// (flip / closed-loop re-root) from its new predecessor. A cheap, robust improvement on the greedy
/// tour that respects unit directionality. Bounded so a huge job falls back to greedy-only.
fn or_opt(seq: Vec<usize>, units: &[Unit], strokes: &[Stroke], start: (f32, f32)) -> Vec<usize> {
    let n = seq.len();
    if n < 3 || n > 400 {
        return seq;
    }
    let cost = |order: &[usize]| -> f32 {
        let mut cursor = start;
        let mut t = 0.0;
        for &ui in order {
            let (pick, c) = reach(&units[ui], strokes, cursor);
            t += c.sqrt();
            cursor = unit_exit(&units[ui], strokes, pick);
        }
        t
    };
    let mut seq = seq;
    let mut best = cost(&seq);
    for _ in 0..4 {
        let mut improved = false;
        for p in 0..seq.len() {
            for q in 0..=seq.len() {
                if q == p || q == p + 1 {
                    continue; // same position
                }
                let mut cand = seq.clone();
                let u = cand.remove(p);
                cand.insert(if q > p { q - 1 } else { q }, u);
                let c = cost(&cand);
                if c + 1e-6 < best {
                    seq = cand;
                    best = c;
                    improved = true;
                }
            }
        }
        if !improved {
            break;
        }
    }
    seq
}

#[cfg(test)]
mod optimize_tests {
    use super::*;
    use crate::geom::Point;

    fn seg(pen: u16, x0: f32, x1: f32) -> Stroke {
        Stroke {
            points: vec![
                Point { x: x0, y: 0.0, pressure: 1.0 },
                Point { x: x1, y: 0.0, pressure: 1.0 },
            ],
            pen,
            reversible: true,
            group: 0,
        }
    }

    /// The number of times the pen changes along the output (the count of M0 pauses + 1 group).
    fn pen_runs(out: &[Stroke]) -> usize {
        out.windows(2).filter(|w| w[0].pen != w[1].pen).count()
    }

    #[test]
    fn keeps_each_pen_contiguous() {
        // Spatially interleaved pens: a pen-blind NN would zig-zag 0→1→0 (2 changes). Pen-aware
        // ordering must finish a pen before switching, so exactly distinct-pens − 1 = 1 change.
        let strokes = vec![seg(0, 0.0, 0.5), seg(1, 1.0, 1.5), seg(0, 2.0, 2.5)];
        let out = order_greedy(&strokes, 0.0, 0.0, &[0, 1]);
        assert_eq!(out.len(), 3);
        assert_eq!(pen_runs(&out), 1, "pens must not interleave");
        assert_eq!(out[0].pen, 0);
        assert_eq!(out[2].pen, 1);
    }

    #[test]
    fn plots_pens_in_palette_order() {
        // Same strokes; palette lists pen 1 before pen 0 → pen 1 plots first, regardless of which
        // is nearer the start. Within a pen, travel is still NN-ordered.
        let strokes = vec![seg(0, 0.0, 0.5), seg(1, 1.0, 1.5), seg(0, 2.0, 2.5)];
        let out = order_greedy(&strokes, 0.0, 0.0, &[1, 0]);
        assert_eq!(pen_runs(&out), 1);
        assert_eq!(out[0].pen, 1, "palette order wins over nearest");
        assert_eq!(out[2].pen, 0);
    }

    #[test]
    fn single_pen_still_greedy_nn() {
        // One pen: behaves exactly like before — nearest-first, flipping reversible strokes.
        let strokes = vec![seg(0, 5.0, 6.0), seg(0, 0.0, 1.0)];
        let out = order_greedy(&strokes, 0.0, 0.0, &[0]);
        assert_eq!(pen_runs(&out), 0);
        assert_eq!(out[0].points[0].x, 0.0, "nearest stroke first");
    }
}
