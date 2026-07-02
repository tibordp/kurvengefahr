//! Wave — a coherent sinusoidal displacement field (the "anharmonic deformation"). Each point is
//! pushed perpendicular to the wave axis by a sum of `harmonics` sines of its position projected onto
//! that axis: harmonic k has period `wavelength/k` and amplitude `amplitude/k`, so one harmonic is a
//! pure sine and several make a richer anharmonic wave. It's a function of position, so it's
//! spatially coherent across a whole group (one field over the combined geometry) and keeps closed
//! contours closed automatically.
use std::f32::consts::PI;

use super::{resample, EffectSpec};
use crate::geom::{Point, Stroke};

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let amp = s.amplitude_mm;
    let wavelength = s.wavelength_mm.max(0.1);
    if amp.abs() <= 1e-4 {
        return strokes.to_vec();
    }
    let harmonics = s.harmonics.clamp(1, 8);
    let a = s.angle_deg * PI / 180.0;
    let (ax, ay) = (a.cos(), a.sin()); // wave axis (travel direction)
    let (px, py) = (-ay, ax); // perpendicular (displacement direction)
    let phase = s.phase_deg * PI / 180.0;
    let k0 = 2.0 * PI / wavelength;
    // Resample fine enough to render the shortest harmonic smoothly.
    let step = (wavelength / harmonics as f32 / 8.0).max(0.2);

    let disp = |x: f32, y: f32| -> f32 {
        let proj = x * ax + y * ay;
        let mut sum = 0.0;
        for k in 1..=harmonics {
            let kf = k as f32;
            sum += (amp / kf) * (kf * k0 * proj + phase).sin();
        }
        sum
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
                    let d = disp(p.x, p.y);
                    Point { x: p.x + px * d, y: p.y + py * d, pressure: p.pressure }
                })
                .collect();
            Stroke { points: out, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group }
        })
        .collect()
}
