//! Smooth — the opposite of roughen: subdivide, then Laplacian-relax. First each segment is split so
//! no piece is longer than `resolution` mm (this is what lets it smooth *anything* — a jagged
//! few-vertex polyline OR an already-curved one gain the interior points relaxation needs). Then each
//! interior point eases toward the midpoint of its neighbours by `strength` (0..1), `iterations`
//! times. Open polylines pin their endpoints (so two strokes sharing a node stay joined —
//! Truchet/Voronoi seams hold); closed contours relax periodically and stay closed.
use super::{is_closed, EffectSpec};
use crate::geom::{Point, Stroke};

#[inline]
fn lerp(a: Point, b: Point, t: f32) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
    }
}

/// Split each segment into ≤`max_seg`-long pieces, keeping every original vertex (so the shape is
/// unchanged, just denser) — the points relaxation then has something to move.
fn subdivide(pts: &[Point], max_seg: f32) -> Vec<Point> {
    let n = pts.len();
    let mut out = Vec::new();
    for i in 0..n - 1 {
        let (a, b) = (pts[i], pts[i + 1]);
        let parts = ((a.x - b.x).hypot(a.y - b.y) / max_seg).ceil().max(1.0) as usize;
        for k in 0..parts {
            out.push(lerp(a, b, k as f32 / parts as f32)); // a + interior; b comes next round
        }
    }
    out.push(pts[n - 1]);
    out
}

#[inline]
fn relax(p: Point, a: Point, b: Point, lambda: f32) -> Point {
    let mx = (a.x + b.x) * 0.5;
    let my = (a.y + b.y) * 0.5;
    Point {
        x: p.x + (mx - p.x) * lambda,
        y: p.y + (my - p.y) * lambda,
        pressure: p.pressure,
    }
}

fn smooth_once(pts: &[Point], lambda: f32, closed: bool) -> Vec<Point> {
    let n = pts.len();
    let mut out = pts.to_vec();
    if closed {
        let m = n - 1; // distinct vertices (the last repeats the first)
        for i in 0..m {
            out[i] = relax(pts[i], pts[(i + m - 1) % m], pts[(i + 1) % m], lambda);
        }
        out[m] = out[0]; // keep it closed
    } else {
        for i in 1..n - 1 {
            out[i] = relax(pts[i], pts[i - 1], pts[i + 1], lambda);
        }
        // endpoints (out[0], out[n-1]) stay pinned
    }
    out
}

/// Subdivide-then-relax one polyline; the shared core of the effect, also used by the
/// Fermat-spiral fill to iron out contour-grid jags. Open polylines pin their endpoints.
pub(crate) fn smooth_pts(
    points: &[Point],
    res: f32,
    lambda: f32,
    iters: usize,
    closed: bool,
) -> Vec<Point> {
    if points.len() < 2 || lambda <= 1e-4 || iters == 0 {
        return points.to_vec();
    }
    let mut pts = subdivide(points, res.max(0.1));
    for _ in 0..iters {
        pts = smooth_once(&pts, lambda.clamp(0.0, 1.0), closed);
    }
    pts
}

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let lambda = s.strength.clamp(0.0, 1.0);
    let iters = s.iterations.min(100);
    let res = s.detail_mm.max(0.1);
    if lambda <= 1e-4 || iters == 0 {
        return strokes.to_vec();
    }
    strokes
        .iter()
        .map(|stroke| {
            if stroke.points.len() < 2 {
                return stroke.clone();
            }
            let closed = is_closed(&stroke.points);
            Stroke {
                points: smooth_pts(&stroke.points, res, lambda, iters as usize, closed),
                pen: stroke.pen,
                reversible: stroke.reversible,
                group: stroke.group,
            }
        })
        .collect()
}
