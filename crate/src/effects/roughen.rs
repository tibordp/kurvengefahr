//! Roughen — the "hand-drawn" look as a **positional turbulence field**: every point is offset by a
//! 2-D noise vector sampled at its own location (low-octave wobble at ~`detailMm` scale, plus an
//! optional finer tremor), not by per-stroke arc-length jitter. Because the offset is a function of
//! position, two strokes that meet at a point get the *same* offset there and stay joined — so a
//! Truchet tiling or a Voronoi mesh (3-way nodes included) roughens without tearing apart at the
//! seams. Seeded for determinism; re-roll = a new field.
use super::{fbm2, noise2, resample, EffectSpec};
use crate::geom::{Point, Stroke};

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let amp = s.amplitude_mm.max(0.0);
    let tremor = s.tremor_mm.max(0.0);
    if amp <= 1e-4 && tremor <= 1e-4 {
        return strokes.to_vec();
    }
    let detail = s.detail_mm.max(0.3);
    let freq = 1.0 / detail; // wobble feature size ≈ detailMm
    let tfreq = 1.0 / 1.5; // tremor: a fixed fine ~1.5 mm shake
                           // Sample finely enough to render the wobble smoothly, scaled to the feature size.
    let step = (detail * 0.25).clamp(0.3, 1.0);
    // Distinct streams per axis so the offset isn't locked to the diagonal.
    let (sax, say) = (s.seed ^ 0x1111_1111, s.seed ^ 0x2222_2222);
    let (stx, sty) = (s.seed ^ 0x3333_3333, s.seed ^ 0x4444_4444);

    let offset = |x: f32, y: f32| -> (f32, f32) {
        let mut ox = amp * fbm2(x * freq, y * freq, sax);
        let mut oy = amp * fbm2(x * freq, y * freq, say);
        if tremor > 0.0 {
            ox += tremor * noise2(x * tfreq, y * tfreq, stx);
            oy += tremor * noise2(x * tfreq, y * tfreq, sty);
        }
        (ox, oy)
    };

    strokes
        .iter()
        .map(|stroke| {
            if stroke.points.len() < 2 {
                return stroke.clone();
            }
            let pts = resample(&stroke.points, step);
            let out = pts
                .iter()
                .map(|p| {
                    let (ox, oy) = offset(p.x, p.y);
                    Point {
                        x: p.x + ox,
                        y: p.y + oy,
                        pressure: p.pressure,
                    }
                })
                .collect();
            // Closed contours stay closed for free: first and last share a position, so they get the
            // same offset.
            Stroke {
                points: out,
                pen: stroke.pen,
                reversible: stroke.reversible,
                group: stroke.group,
            }
        })
        .collect()
}
