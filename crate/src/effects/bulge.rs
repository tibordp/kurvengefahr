//! Bulge / pinch — scale each point radially about the geometry centre: `strength` > 0 pushes points
//! outward (bulge), < 0 pulls them inward (pinch), fading to no change at `radius_mm`. Straight
//! segments are resampled first so they curve. A function of position → closed contours stay closed.
use super::{centroid, resample, EffectSpec};
use crate::geom::{Point, Stroke};
use crate::tess::EFFECT_RESAMPLE_STEP;

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let strength = s.strength.clamp(-1.0, 1.0);
    let radius = s.radius_mm.max(0.1);
    if strength.abs() <= 1e-4 {
        return strokes.to_vec();
    }
    let (cx, cy) = centroid(strokes);

    strokes
        .iter()
        .map(|stroke| {
            if stroke.points.len() < 2 {
                return stroke.clone();
            }
            let pts = resample(&stroke.points, EFFECT_RESAMPLE_STEP);
            let out = pts
                .iter()
                .map(|p| {
                    let (dx, dy) = (p.x - cx, p.y - cy);
                    let r = dx.hypot(dy);
                    let falloff = (1.0 - r / radius).clamp(0.0, 1.0);
                    // Smooth radial gain: outward for +strength, inward for −strength.
                    let gain = 1.0 + strength * falloff;
                    Point { x: cx + dx * gain, y: cy + dy * gain, pressure: p.pressure }
                })
                .collect();
            Stroke { points: out, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group }
        })
        .collect()
}
