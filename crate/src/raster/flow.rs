//! **Flow field** (`flowfield`): streamlines that flow along the image's edges. The field is the
//! *edge tangent* (perpendicular to the inkness gradient), so strokes hug contours and wrap around
//! form like directional pen shading; in flat regions (no gradient) they fall back to the base angle.
//! Seeds land in dark areas (density-weighted) and each grows a streamline forward and backward.
//! Seeded + randomized ⇒ manual-regenerate, progressive draw-in.

use super::{pt, stroke, Grid, Params, Rng};
use crate::geom::{Point, Stroke};

/// Streamline seeds per mm² at `detail = 1` (sparse — each seed spans a whole streamline).
const SEED_DENSITY: f32 = crate::tess::RASTER_FLOW_SEED_DENSITY;
const MAX_SEEDS: usize = 6000;
/// Integration step (mm) and the inkness floor below which a streamline stops (leaves the subject).
const STEP: f32 = crate::tess::RASTER_FLOW_STEP;
const INK_FLOOR: f32 = 0.06;

pub fn flow(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let target =
        (((grid.tw * grid.th) * SEED_DENSITY * p.detail.clamp(0.0, 1.0)) as usize).min(MAX_SEEDS);
    if target == 0 {
        return vec![];
    }
    let half = (p.flow_steps.clamp(4, 4000) / 2).max(2) as usize;
    let base = p.angle.to_radians();
    let bdir = (base.cos(), base.sin());
    let mut rng = Rng::new(p.seed);
    let mut out = Vec::new();
    let mut attempts = 0usize;
    let budget = target.saturating_mul(40).max(10_000);
    while out.len() < target && attempts < budget {
        attempts += 1;
        let x = rng.f32() * grid.tw;
        let y = rng.f32() * grid.th;
        if rng.f32() >= grid.ink_mm(x, y) {
            continue;
        }
        let t0 = tangent(grid, x, y, bdir);
        let fwd = trace(grid, x, y, t0, half);
        let bwd = trace(grid, x, y, (-t0.0, -t0.1), half);
        // Stitch backward (reversed) + forward into one centred streamline.
        let mut pts: Vec<Point> = bwd.into_iter().rev().collect();
        if !pts.is_empty() {
            pts.pop(); // drop the duplicated seed
        }
        pts.extend(fwd);
        if pts.len() >= 2 {
            out.push(stroke(pts));
        }
    }
    out
}

/// Edge-tangent direction (unit) at a point: perpendicular to the inkness gradient, sign-aligned to
/// `prev` for continuity. Falls back to the base direction where the gradient vanishes.
fn tangent(grid: &Grid, x: f32, y: f32, prev: (f32, f32)) -> (f32, f32) {
    let h = STEP;
    let gx = grid.ink_mm(x + h, y) - grid.ink_mm(x - h, y);
    let gy = grid.ink_mm(x, y + h) - grid.ink_mm(x, y - h);
    let (mut tx, mut ty) = (-gy, gx);
    let m = (tx * tx + ty * ty).sqrt();
    if m < 1e-4 {
        (tx, ty) = prev; // flat region: keep flowing the base direction
    } else {
        tx /= m;
        ty /= m;
    }
    // Keep heading continuous (don't let the tangent flip 180° between steps).
    if tx * prev.0 + ty * prev.1 < 0.0 {
        (tx, ty) = (-tx, -ty);
    }
    (tx, ty)
}

/// Integrate a streamline from (x,y) heading `dir0`, up to `steps` steps, stopping at the box edge or
/// where the image goes light. Includes the start point.
fn trace(grid: &Grid, mut x: f32, mut y: f32, mut dir: (f32, f32), steps: usize) -> Vec<Point> {
    let mut pts = vec![pt(x, y)];
    for _ in 0..steps {
        dir = tangent(grid, x, y, dir);
        x += dir.0 * STEP;
        y += dir.1 * STEP;
        if x < 0.0 || y < 0.0 || x > grid.tw || y > grid.th || grid.ink_mm(x, y) < INK_FLOOR {
            break;
        }
        pts.push(pt(x, y));
    }
    pts
}
