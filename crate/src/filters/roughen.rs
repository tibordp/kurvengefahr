//! Roughen — the "hand-drawn" look: resample to even spacing, then nudge each point along the local
//! normal by smooth two-octave noise (the wobble) plus an optional fine 2-D tremor (the shake). The
//! noise streams are keyed by `seed` + the stroke index, so strokes differ but a re-roll (new seed)
//! is deterministic. Closed contours are re-closed so a shape stays a shape.
use super::{fbm1, is_closed, noise1, resample, FilterSpec};
use crate::geom::{Point, Stroke};

pub fn apply(strokes: &[Stroke], s: &FilterSpec) -> Vec<Stroke> {
    let amp = s.amplitude_mm.max(0.0);
    let tremor = s.tremor_mm.max(0.0);
    if amp <= 1e-4 && tremor <= 1e-4 {
        return strokes.to_vec();
    }
    let detail = s.detail_mm.max(0.3);
    // Feature size ≈ 4 samples, so the wobble undulates rather than buzzing point-to-point.
    let freq = 1.0 / (detail * 4.0);

    strokes
        .iter()
        .enumerate()
        .map(|(si, stroke)| {
            if stroke.points.len() < 2 {
                return stroke.clone();
            }
            let closed = is_closed(&stroke.points);
            let pts = resample(&stroke.points, detail);
            let n = pts.len();
            let seed = s.seed.wrapping_add((si as u32).wrapping_mul(0x9e37_79b1));
            let mut acc = 0.0f32;
            let mut out: Vec<Point> = Vec::with_capacity(n);
            for i in 0..n {
                if i > 0 {
                    acc += (pts[i].x - pts[i - 1].x).hypot(pts[i].y - pts[i - 1].y);
                }
                // Local tangent → unit normal.
                let prev = pts[if i == 0 { 0 } else { i - 1 }];
                let next = pts[if i + 1 < n { i + 1 } else { i }];
                let (tx, ty) = (next.x - prev.x, next.y - prev.y);
                let len = tx.hypot(ty).max(1e-6);
                let (nx, ny) = (-ty / len, tx / len);
                let w = amp * fbm1(acc * freq, seed);
                // Fine tremor: independent high-frequency jitter in x and y.
                let jx = tremor * noise1(acc * 1.7 + 3.1, seed ^ 0x1234_5678);
                let jy = tremor * noise1(acc * 1.9 + 7.7, seed ^ 0x8765_4321);
                out.push(Point {
                    x: pts[i].x + nx * w + jx,
                    y: pts[i].y + ny * w + jy,
                    pressure: pts[i].pressure,
                });
            }
            if closed && out.len() > 1 {
                let first = out[0];
                *out.last_mut().unwrap() = first; // keep the contour closed (no seam gap)
            }
            Stroke { points: out, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group }
        })
        .collect()
}
