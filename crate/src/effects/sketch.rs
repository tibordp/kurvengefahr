//! Sketch — the multi-pass pen look: emit each stroke `passes` times, every pass displaced by its own
//! gentle positional wander field (a different seed per pass), so the passes don't overlap exactly,
//! like a hand re-drawing a line. The wander is a function of position (like roughen), so within a
//! given pass two strokes that share a point stay joined — a Truchet/Voronoi mesh overdraws without
//! tearing at the seams. Each pass keeps the source stroke's pen/reversible/group; the optimizer plots
//! them as separate singletons. Deterministic per `seed` (+ pass).
use super::{fbm2, resample, EffectSpec};
use crate::geom::{Point, Stroke};

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let passes = s.passes.clamp(1, 6);
    let offset = s.offset_mm.max(0.0);
    if passes <= 1 || offset <= 1e-4 {
        return strokes.to_vec();
    }
    let freq = 1.0 / 25.0; // a gentle, large-scale wander (each pass drifts slowly across the work)
    let step = 2.0;

    let mut out: Vec<Stroke> = Vec::with_capacity(strokes.len() * passes as usize);
    for stroke in strokes {
        if stroke.points.len() < 2 {
            out.push(stroke.clone());
            continue;
        }
        let pts = resample(&stroke.points, step);
        for pass in 0..passes {
            // A distinct field per pass (so passes differ), shared across strokes (so seams hold).
            let base = s.seed.wrapping_add(pass.wrapping_mul(0x9e37_79b1));
            let (sx, sy) = (base ^ 0xaaaa_aaaa, base ^ 0x5555_5555);
            let pp: Vec<Point> = pts
                .iter()
                .map(|p| Point {
                    x: p.x + offset * fbm2(p.x * freq, p.y * freq, sx),
                    y: p.y + offset * fbm2(p.x * freq, p.y * freq, sy),
                    pressure: p.pressure,
                })
                .collect();
            out.push(Stroke {
                points: pp,
                pen: stroke.pen,
                reversible: stroke.reversible,
                group: stroke.group,
            });
        }
    }
    out
}
