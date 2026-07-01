//! **Tonal hatching** (`hatch`): engraving-style cross-hatch. Tone is quantized into `levels` bands;
//! each band lays one set of parallel hatch lines at its own angle, but only *where the image is at
//! least that dark*. Darker regions clear more thresholds, so they accrue more overlapping passes —
//! light greys get a single sparse rake, blacks get a dense cross-hatch. Pure line work, no fills.
//!
//! **Pressure hatch** (`pressurehatch`): the same even rake of parallel lines, but tone rides on pen
//! *pressure* rather than line *density* — each point carries the local darkness as its pressure, so
//! light greys draw feather-light and blacks bear down hard. The line lifts over near-white paper so
//! whites stay white. On a pressure-pen plotter this renders the full tonal range from one uniform,
//! constant-spacing hatch; on a plain pen-up/down machine (no `downLight`) it degrades to a flat
//! single hatch. The per-point pressure survives place/clip/optimize and drives a Z ramp in `emit`.

use super::{stroke, Grid, Params};
use crate::geom::{Point, Stroke};

/// March step along each hatch line (mm). Fine enough to catch tone boundaries cleanly without
/// generating excess vertices.
const STEP: f32 = crate::tess::RASTER_HATCH_STEP;

pub fn hatch(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let levels = p.levels.clamp(1, MAX_LEVELS) as usize;
    let spacing = p.spacing.max(0.2);
    let mut out = Vec::new();
    // Band k (1..=levels) inks where inkness ≥ k/(levels+1); each gets its own angle so successive
    // bands cross rather than retread. The angles are spread evenly across a half-turn (a hatch line
    // and its 180° flip are the same), so any band count cross-hatches cleanly — at 4 bands this is
    // the classic 0/45/90/135, but it generalizes to whatever `levels` is, no snapping to 45°.
    for k in 1..=levels {
        let cutoff = k as f32 / (levels as f32 + 1.0);
        let angle = p.angle + (k - 1) as f32 * 180.0 / levels as f32;
        hatch_pass(grid, angle, spacing, |ink| ink >= cutoff, &mut out);
    }
    out
}

/// Upper bound on tone bands — generous, just a guard against a pathological `levels`. Each band is
/// one full hatch pass, so this also bounds the work.
const MAX_LEVELS: u32 = 16;

/// Rake parallel lines (direction `angle_deg`, `spacing` apart) across the box, emitting a stroke for
/// each maximal run where `keep(inkness)` holds. Shared by tone bands.
pub fn hatch_pass(
    grid: &Grid,
    angle_deg: f32,
    spacing: f32,
    keep: impl Fn(f32) -> bool,
    out: &mut Vec<Stroke>,
) {
    let a = angle_deg.to_radians();
    let (dx, dy) = (a.cos(), a.sin()); // line direction
    let (nx, ny) = (-dy, dx); // line normal (offset axis)
    let (tw, th) = (grid.tw, grid.th);
    // Project the box corners onto the direction/normal axes to get the sweep ranges.
    let corners = [(0.0, 0.0), (tw, 0.0), (0.0, th), (tw, th)];
    let proj = |px: f32, py: f32, ax: f32, ay: f32| px * ax + py * ay;
    let (mut tmin, mut tmax, mut omin, mut omax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for &(cx, cy) in &corners {
        let t = proj(cx, cy, dx, dy);
        let o = proj(cx, cy, nx, ny);
        tmin = tmin.min(t);
        tmax = tmax.max(t);
        omin = omin.min(o);
        omax = omax.max(o);
    }
    let eps = 1e-3;
    let mut o = omin + spacing * 0.5;
    while o <= omax {
        let mut seg: Vec<Point> = Vec::new();
        let mut t = tmin;
        while t <= tmax {
            let x = o * nx + t * dx;
            let y = o * ny + t * dy;
            let inside = x >= -eps && y >= -eps && x <= tw + eps && y <= th + eps;
            if inside && keep(grid.ink_mm(x, y)) {
                seg.push(Point { x, y, pressure: 1.0 });
            } else if seg.len() >= 2 {
                out.push(stroke(std::mem::take(&mut seg)));
            } else {
                seg.clear();
            }
            t += STEP;
        }
        if seg.len() >= 2 {
            out.push(stroke(seg));
        }
        o += spacing;
    }
}

/// Inkness floor below which the pen lifts (paper): only near-white breaks a line, so light greys
/// still draw (feather-light) rather than punching gaps.
const INK_FLOOR: f32 = 0.06;

/// Contrast curve for the pressure map, pivoted on mid grey: `c == 1` is linear (pressure = inkness),
/// `c > 1` expands the tonal range (more pressure contrast — for flat source images), `c < 1`
/// compresses it toward mid. Clamped to a usable pressure.
fn contrast(v: f32, c: f32) -> f32 {
    (0.5 + (v - 0.5) * c).clamp(0.0, 1.0)
}

/// Pressure-modulated single hatch: one even rake of parallel lines (`angle_deg`, `spacing` apart),
/// each marched point tagged with `pressure = contrast(inkness)` so darkness reads as pen pressure,
/// not line density. Lines break wherever inkness drops below [`INK_FLOOR`] (paper). Same sweep
/// geometry as [`hatch_pass`]; only the per-point tagging and the break rule differ.
pub fn pressure_hatch(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let spacing = p.spacing.max(0.2);
    let c = p.pressure_contrast.max(0.0);
    let a = p.angle.to_radians();
    let (dx, dy) = (a.cos(), a.sin()); // line direction
    let (nx, ny) = (-dy, dx); // line normal (offset axis)
    let (tw, th) = (grid.tw, grid.th);
    let corners = [(0.0, 0.0), (tw, 0.0), (0.0, th), (tw, th)];
    let proj = |px: f32, py: f32, ax: f32, ay: f32| px * ax + py * ay;
    let (mut tmin, mut tmax, mut omin, mut omax) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for &(cx, cy) in &corners {
        let t = proj(cx, cy, dx, dy);
        let o = proj(cx, cy, nx, ny);
        tmin = tmin.min(t);
        tmax = tmax.max(t);
        omin = omin.min(o);
        omax = omax.max(o);
    }
    let eps = 1e-3;
    let mut out = Vec::new();
    let mut o = omin + spacing * 0.5;
    while o <= omax {
        let mut seg: Vec<Point> = Vec::new();
        let mut t = tmin;
        while t <= tmax {
            let x = o * nx + t * dx;
            let y = o * ny + t * dy;
            let inside = x >= -eps && y >= -eps && x <= tw + eps && y <= th + eps;
            let ink = if inside { grid.ink_mm(x, y) } else { 0.0 };
            if ink > INK_FLOOR {
                seg.push(Point { x, y, pressure: contrast(ink, c) });
            } else if seg.len() >= 2 {
                out.push(stroke(std::mem::take(&mut seg)));
            } else {
                seg.clear();
            }
            t += STEP;
        }
        if seg.len() >= 2 {
            out.push(stroke(seg));
        }
        o += spacing;
    }
    out
}

