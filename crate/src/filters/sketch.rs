//! Sketch — the multi-pass pen look: emit each stroke `passes` times, every pass wandering by a
//! slowly-varying 2-D offset (so the passes don't overlap exactly, like a hand re-drawing a line).
//! Each pass keeps the source stroke's pen/reversible/group; the optimizer plots them as separate
//! singletons. Deterministic per `seed` (+ stroke + pass).
use super::{fbm1, is_closed, resample, FilterSpec};
use crate::geom::{Point, Stroke};

pub fn apply(strokes: &[Stroke], s: &FilterSpec) -> Vec<Stroke> {
    let passes = s.passes.clamp(1, 6);
    let offset = s.offset_mm.max(0.0);
    if passes <= 1 || offset <= 1e-4 {
        return strokes.to_vec();
    }
    let mut out: Vec<Stroke> = Vec::with_capacity(strokes.len() * passes as usize);
    for (si, stroke) in strokes.iter().enumerate() {
        if stroke.points.len() < 2 {
            out.push(stroke.clone());
            continue;
        }
        let closed = is_closed(&stroke.points);
        let pts = resample(&stroke.points, 2.0);
        for pass in 0..passes {
            let seed = s
                .seed
                .wrapping_add((si as u32).wrapping_mul(0x9e37_79b1))
                .wrapping_add((pass as u32).wrapping_mul(0x85eb_ca6b));
            let mut acc = 0.0f32;
            let mut pp: Vec<Point> = Vec::with_capacity(pts.len());
            for i in 0..pts.len() {
                if i > 0 {
                    acc += (pts[i].x - pts[i - 1].x).hypot(pts[i].y - pts[i - 1].y);
                }
                let t = acc * 0.08; // low frequency → a gentle, whole-line wander per pass
                let dx = offset * fbm1(t, seed ^ 0x00a1_b2c3);
                let dy = offset * fbm1(t + 5.5, seed ^ 0x00c3_b2a1);
                pp.push(Point { x: pts[i].x + dx, y: pts[i].y + dy, pressure: pts[i].pressure });
            }
            if closed && pp.len() > 1 {
                let first = pp[0];
                *pp.last_mut().unwrap() = first;
            }
            out.push(Stroke { points: pp, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group });
        }
    }
    out
}
