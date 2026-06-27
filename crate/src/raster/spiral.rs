//! **Modulated spiral** (`spiral`): one continuous Archimedean spiral from the centre out, its radius
//! perturbed in/out by a high-frequency wiggle whose amplitude tracks local darkness. Dark regions
//! bloom into thick oscillating bands, light regions stay smooth — the whole portrait drawn without
//! ever lifting the pen. Inscribed in a centred circle, so it reads as a vignette.

use super::{pt, Grid, Params};
use crate::geom::{Point, Stroke};

/// Arc step along the spiral (mm).
const STEP: f32 = crate::tess::RASTER_SPIRAL_STEP;

pub fn spiral(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let cx = grid.tw * 0.5;
    let cy = grid.th * 0.5;
    let max_r = grid.tw.min(grid.th) * 0.5; // inscribe a centred circle
    let pitch = p.spacing.max(0.3); // radius gained per turn
    let b = pitch / std::f32::consts::TAU; // r = b·θ
    if b <= 0.0 || max_r <= pitch {
        return vec![];
    }
    // Wiggle: constant spatial wavelength (cycles/mm from the frequency knob), amplitude ∝ darkness.
    let spatial = (p.frequency.max(0.1) * 0.08) * std::f32::consts::TAU;
    // Amplitude is unbounded — the line may swell across neighbouring turns, which is the point.
    let amp = p.amplitude.max(0.0);
    let mut pts: Vec<Point> = Vec::new();
    let mut theta = 0.0f32;
    let mut phase = 0.0f32;
    loop {
        let r = b * theta;
        if r > max_r {
            break;
        }
        let (c, s) = (theta.cos(), theta.sin());
        let bx = cx + r * c;
        let by = cy + r * s;
        let ink = grid.ink_mm(bx, by);
        let rr = r + amp * ink * phase.sin();
        pts.push(pt(cx + rr * c, cy + rr * s));
        // Advance ~STEP of arc length; clamp dθ near the centre where r is tiny.
        let dtheta = (STEP / r.max(pitch * 0.25)).min(0.5);
        theta += dtheta;
        phase += spatial * STEP;
    }
    if pts.len() < 2 {
        return vec![];
    }
    // One unbroken designed path.
    vec![Stroke { points: pts, pen: 0, reversible: false, group: 0 }]
}
