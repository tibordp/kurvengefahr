//! Twist (swirl) — rotate each point about the geometry centre by an angle that fades from
//! `angle_deg` at the centre to 0 at `radius_mm` (a radius-dependent rotation). Straight segments are
//! resampled first so they bend into the swirl. A function of position → closed contours stay closed.
use std::f32::consts::PI;

use super::{centroid, resample, EffectSpec};
use crate::geom::{Point, Stroke};
use crate::tess::EFFECT_RESAMPLE_STEP;

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let max_angle = s.angle_deg * PI / 180.0;
    let radius = s.radius_mm.max(0.1);
    if max_angle.abs() <= 1e-4 {
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
                    let a = max_angle * falloff;
                    let (sa, ca) = a.sin_cos();
                    Point { x: cx + dx * ca - dy * sa, y: cy + dx * sa + dy * ca, pressure: p.pressure }
                })
                .collect();
            Stroke { points: out, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group }
        })
        .collect()
}
