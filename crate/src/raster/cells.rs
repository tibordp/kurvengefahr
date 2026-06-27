//! **Voronoi mosaic** (`voronoi`): density-weighted points (dense where the image is dark, via the
//! same rejection sampler as TSP), then the Voronoi diagram of those points clipped to the image —
//! small cells in dark areas, big cells in light, a crystalline rendering of the tones. Optionally
//! Lloyd-relaxed a few iterations so the cells read as an even mosaic rather than noisy slivers.
//! Seeded/randomized. Edges share vertices, so the optimizer chains them into the cell network.
use super::tsp::sample;
use super::{pt, Grid, Params};
use crate::geom::Stroke;

const MAX_PTS: usize = 12000;

fn circumcenter(a: &delaunator::Point, b: &delaunator::Point, c: &delaunator::Point) -> (f64, f64) {
    let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if d.abs() < 1e-12 {
        return ((a.x + b.x + c.x) / 3.0, (a.y + b.y + c.y) / 3.0);
    }
    let (a2, b2, c2) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
    let ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    let uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    (ux, uy)
}

/// Liang–Barsky clip of a segment to `[0,w]×[0,h]`; None if it misses the box.
fn clip_box(x0: f64, y0: f64, x1: f64, y1: f64, w: f64, h: f64) -> Option<((f64, f64), (f64, f64))> {
    let (dx, dy) = (x1 - x0, y1 - y0);
    let p = [-dx, dx, -dy, dy];
    let q = [x0, w - x0, y0, h - y0];
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for i in 0..4 {
        if p[i] == 0.0 {
            if q[i] < 0.0 {
                return None;
            }
        } else {
            let t = q[i] / p[i];
            if p[i] < 0.0 {
                if t > t1 {
                    return None;
                }
                t0 = t0.max(t);
            } else {
                if t < t0 {
                    return None;
                }
                t1 = t1.min(t);
            }
        }
    }
    Some(((x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy)))
}

pub fn voronoi(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let target = (p.detail.clamp(0.0, 1.0) * MAX_PTS as f32) as usize;
    let pts = sample(grid, p.seed, target.max(3));
    if pts.len() < 3 {
        return vec![];
    }
    let mut dpts: Vec<delaunator::Point> = pts.iter().map(|&(x, y)| delaunator::Point { x: x as f64, y: y as f64 }).collect();

    // One inkness-weighted Lloyd pass: move each site to the ink-weighted centroid of its cell, so
    // dense areas stay dense but the cells even out from noisy slivers into a clean mosaic. (One pass
    // is the bulk of the de-clumping; more passes cost another image-grid sweep each for little gain.)
    {
        let tri = delaunator::triangulate(&dpts);
        if !tri.triangles.is_empty() {
            dpts = lloyd_step(grid, &dpts, &tri);
        }
    }

    let tri = delaunator::triangulate(&dpts);
    if tri.triangles.is_empty() {
        return vec![];
    }
    let nt = tri.triangles.len() / 3;
    let cc: Vec<(f64, f64)> =
        (0..nt).map(|t| circumcenter(&dpts[tri.triangles[3 * t]], &dpts[tri.triangles[3 * t + 1]], &dpts[tri.triangles[3 * t + 2]])).collect();
    let (w, h) = (grid.tw as f64, grid.th as f64);
    // The full Voronoi diagram, clipped to the image box (the hull cells clip to long radial walls —
    // a deliberate part of the look). Edges share circumcenter vertices, so the optimizer chains them.
    let mut out = Vec::new();
    for e in 0..tri.halfedges.len() {
        let o = tri.halfedges[e];
        if o != delaunator::EMPTY && e < o {
            let (a, b) = (cc[e / 3], cc[o / 3]);
            if let Some(((cx1, cy1), (cx2, cy2))) = clip_box(a.0, a.1, b.0, b.1, w, h) {
                out.push(Stroke {
                    points: vec![pt(cx1 as f32, cy1 as f32), pt(cx2 as f32, cy2 as f32)],
                    pen: 0,
                    reversible: true,
                    group: 0,
                });
            }
        }
    }
    out
}

/// One Lloyd relaxation step: each site → the inkness-weighted centroid of pixels closest to it.
/// Approximated by binning a grid of sample points to their nearest site (found via the Delaunay
/// neighbourhood through the current triangulation's nearest vertex by walking the hull is overkill,
/// so we bucket sites into a coarse grid and test the local 3×3).
fn lloyd_step(grid: &Grid, sites: &[delaunator::Point], _tri: &delaunator::Triangulation) -> Vec<delaunator::Point> {
    let (w, h) = (grid.tw, grid.th);
    let n = sites.len();
    // Coarse bucket grid over the sites for nearest-site queries.
    let cell = (w * h / n as f32).sqrt().max(1.0);
    let (cols, rows) = ((w / cell) as i32 + 2, (h / cell) as i32 + 2);
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); (cols * rows) as usize];
    let bidx = |x: f32, y: f32| -> usize {
        let cx = ((x / cell) as i32).clamp(0, cols - 1);
        let cy = ((y / cell) as i32).clamp(0, rows - 1);
        (cy * cols + cx) as usize
    };
    for (i, s) in sites.iter().enumerate() {
        buckets[bidx(s.x as f32, s.y as f32)].push(i);
    }
    let mut sum = vec![(0.0f32, 0.0f32, 0.0f32); n]; // weighted (x, y, weight)
    // Sample the image on a fine grid; assign each to its nearest site, weight by inkness.
    let step = (cell * 0.5).max(0.75);
    let mut sy = step * 0.5;
    while sy < h {
        let mut sx = step * 0.5;
        while sx < w {
            let wgt = grid.ink_mm(sx, sy) + 0.02; // small floor so light areas still pull cells
            let (cx, cy) = (((sx / cell) as i32), ((sy / cell) as i32));
            let mut best = usize::MAX;
            let mut bestd = f32::MAX;
            for gy in (cy - 1).max(0)..=(cy + 1).min(rows - 1) {
                for gx in (cx - 1).max(0)..=(cx + 1).min(cols - 1) {
                    for &i in &buckets[(gy * cols + gx) as usize] {
                        let d = (sites[i].x as f32 - sx).powi(2) + (sites[i].y as f32 - sy).powi(2);
                        if d < bestd {
                            bestd = d;
                            best = i;
                        }
                    }
                }
            }
            if best != usize::MAX {
                sum[best].0 += sx * wgt;
                sum[best].1 += sy * wgt;
                sum[best].2 += wgt;
            }
            sx += step;
        }
        sy += step;
    }
    sites
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if sum[i].2 > 1e-6 {
                delaunator::Point { x: (sum[i].0 / sum[i].2) as f64, y: (sum[i].1 / sum[i].2) as f64 }
            } else {
                delaunator::Point { x: s.x, y: s.y }
            }
        })
        .collect()
}
