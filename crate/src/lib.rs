//! Toolpath + mark generation for Kurvengefahr — all the "fancy" geometry work, in Rust.
//!
//! Two WASM entry points, both returning the same flat `GeometryBuffers` (see `geom.rs`),
//! so JS has a single geometry decode path:
//!
//!   - `generate_handwriting` — text → strokes (synthetic model + typesetter; the RNN slots
//!      in behind the `StrokeModel` trait later, invisibly to JS).
//!   - `optimize` — strokes → reordered strokes (greedy nearest-neighbour, honours
//!      `reversible`; seed of the Z-aware lift-minimizer).

mod clip;
mod geom;
mod stroke_model;
mod typeset;

use wasm_bindgen::prelude::*;

use clip::Rect;
use geom::{decode, GeometryBuffers, Stroke};
use stroke_model::{StrokeModel, SyntheticStrokeModel};
use typeset::{typeset, Align, Layout};

/// Generate handwriting geometry (element-local mm) from text + layout. The whole
/// model→typesetter path is here; JS just unflattens the result like any other geometry.
#[wasm_bindgen]
pub fn generate_handwriting(
    text: &str,
    font_size_mm: f32,
    line_height_em: f32,
    max_width_mm: f32,
    align: u8,
    slant_deg: f32,
    seed: u32,
) -> GeometryBuffers {
    let glyphs = SyntheticStrokeModel.generate(text, seed);
    let layout = Layout {
        font_size_mm,
        line_height_em,
        max_width_mm,
        align: Align::from_u8(align),
        slant_deg,
    };
    GeometryBuffers::from_strokes(&typeset(&glyphs, &layout))
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
) -> GeometryBuffers {
    let strokes = decode(xy, pressure, offsets, pen, reversible, group);
    GeometryBuffers::from_strokes(&order_greedy(&strokes, start_x, start_y))
}

/// An orderable unit: the indices of the strokes it covers (in plot order), whether it may be
/// flipped, and its entry/exit endpoints. A locked chain spans many strokes and can't flip; a
/// singleton is one stroke that flips iff reversible.
struct Unit {
    strokes: Vec<usize>,
    reversible: bool,
    entry: (f32, f32),
    exit: (f32, f32),
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

fn order_greedy(strokes: &[Stroke], start_x: f32, start_y: f32) -> Vec<Stroke> {
    let units = build_units(strokes);
    let n = units.len();
    let mut used = vec![false; n];
    let mut cursor = (start_x, start_y);
    let mut out: Vec<Stroke> = Vec::with_capacity(strokes.len());

    for _ in 0..n {
        let mut best: Option<(usize, bool, f32)> = None; // (unit index, flip, cost)
        for (i, u) in units.iter().enumerate() {
            if used[i] {
                continue;
            }
            let from_entry = dist2(cursor, u.entry);
            let (flip, cost) = if u.reversible && dist2(cursor, u.exit) < from_entry {
                (true, dist2(cursor, u.exit))
            } else {
                (false, from_entry)
            };
            if best.map_or(true, |(_, _, bc)| cost < bc) {
                best = Some((i, flip, cost));
            }
        }

        let (idx, flip, _) = match best {
            Some(b) => b,
            None => break,
        };
        used[idx] = true;
        let u = &units[idx];

        if flip {
            // Only singletons are reversible, so a flipped unit is exactly one stroke.
            out.push(clone_stroke(&strokes[u.strokes[0]], true));
            cursor = u.entry;
        } else {
            for &si in &u.strokes {
                out.push(clone_stroke(&strokes[si], false));
            }
            cursor = u.exit;
        }
    }

    out
}
