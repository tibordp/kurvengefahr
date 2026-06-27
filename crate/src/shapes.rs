//! Tessellation of vector primitives (rectangle, ellipse, cubic-Bézier path) into millimetre
//! polyline `Stroke`s, plus Ramer–Douglas–Peucker simplification for freehand capture. Output is in
//! the element's local space; place→clip→optimize→emit does the rest. Pure scalar Rust.

use crate::geom::{Point, Stroke};

/// Default chord tolerance (mm) for flattening curves — well below a pen's line width.
const DEFAULT_TOL: f32 = crate::tess::PATH_FLATTEN_TOL;

fn pt(x: f32, y: f32) -> Point {
    Point { x, y, pressure: 1.0 }
}

fn stroke(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}

/// Axis-aligned rectangle from (0,0) to (w,h) as a closed polyline. `r` rounds the corners with
/// quarter-arcs (clamped to ≤ half the shorter side); `r ≤ 0` gives sharp corners.
pub fn rect(w: f32, h: f32, r: f32) -> Vec<Stroke> {
    let r = r.max(0.0).min(w.min(h) * 0.5);
    if r <= 1e-3 {
        return vec![stroke(vec![pt(0.0, 0.0), pt(w, 0.0), pt(w, h), pt(0.0, h), pt(0.0, 0.0)])]
    }
    use std::f32::consts::{FRAC_PI_2, PI};
    let nseg = (FRAC_PI_2 / (2.0 * DEFAULT_TOL / r).sqrt()).ceil().clamp(2.0, 64.0) as usize;
    let mut pts: Vec<Point> = Vec::new();
    let mut arc = |cx: f32, cy: f32, a0: f32, a1: f32| {
        for i in 0..=nseg {
            let t = a0 + (a1 - a0) * (i as f32 / nseg as f32);
            pts.push(pt(cx + r * t.cos(), cy + r * t.sin()));
        }
    };
    arc(w - r, r, -FRAC_PI_2, 0.0); // top-right
    arc(w - r, h - r, 0.0, FRAC_PI_2); // bottom-right
    arc(r, h - r, FRAC_PI_2, PI); // bottom-left
    arc(r, r, PI, PI + FRAC_PI_2); // top-left
    let first = pts[0];
    pts.push(first); // close
    vec![stroke(pts)]
}

/// Ellipse centred at (0,0) with radii (rx, ry), closed polyline. Segment count adapts to the
/// radius so large ellipses stay smooth (max chord sagitta ≈ DEFAULT_TOL).
pub fn ellipse(rx: f32, ry: f32) -> Vec<Stroke> {
    let r = rx.abs().max(ry.abs()).max(1e-3);
    // sagitta r·(1−cos(π/n)) ≈ r·(π/n)²/2 ≤ tol  ⇒  n ≥ π / sqrt(2·tol/r)
    let n = (std::f32::consts::PI / (2.0 * DEFAULT_TOL / r).sqrt())
        .ceil()
        .clamp(16.0, 512.0) as usize;
    let mut points = Vec::with_capacity(n + 1);
    for i in 0..=n {
        let t = (i as f32 / n as f32) * std::f32::consts::TAU;
        points.push(pt(rx * t.cos(), ry * t.sin()));
    }
    vec![stroke(points)]
}

/// Flatten a sequence of cubic-Bézier nodes into one polyline stroke. `nodes` is 6 floats per node:
/// `[x, y, hinX, hinY, houtX, houtY]`, handles **relative** to the anchor. Segment i→i+1 is the
/// cubic (Pᵢ, Pᵢ+houtᵢ, Pⱼ+hinⱼ, Pⱼ); zero-length handles give a straight line, so polyline and
/// Bézier share one path. `closed` adds a final segment from the last node back to the first.
pub fn path(nodes: &[f32], closed: bool, tol: f32) -> Vec<Stroke> {
    let n = nodes.len() / 6;
    if n == 0 {
        return vec![];
    }
    let anchor = |i: usize| (nodes[i * 6], nodes[i * 6 + 1]);
    let hin = |i: usize| (nodes[i * 6 + 2], nodes[i * 6 + 3]);
    let hout = |i: usize| (nodes[i * 6 + 4], nodes[i * 6 + 5]);
    let tol = if tol > 0.0 { tol } else { DEFAULT_TOL };

    let (sx, sy) = anchor(0);
    let mut points = vec![pt(sx, sy)];
    if n == 1 {
        return vec![stroke(points)];
    }

    let seg_count = if closed { n } else { n - 1 };
    for s in 0..seg_count {
        let i = s;
        let j = (s + 1) % n;
        let (p0x, p0y) = anchor(i);
        let (hox, hoy) = hout(i);
        let (hjx, hjy) = hin(j);
        let (p3x, p3y) = anchor(j);
        flatten_cubic(
            (p0x, p0y),
            (p0x + hox, p0y + hoy),
            (p3x + hjx, p3y + hjy),
            (p3x, p3y),
            tol,
            &mut points,
        );
    }
    vec![stroke(points)]
}

type P = (f32, f32);
fn mid(a: P, b: P) -> P {
    ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5)
}

/// Perpendicular distance from `p` to the line through `a`,`b`.
fn dist_pt_line(p: P, a: P, b: P) -> f32 {
    let dx = b.0 - a.0;
    let dy = b.1 - a.1;
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return ((p.0 - a.0).powi(2) + (p.1 - a.1).powi(2)).sqrt();
    }
    ((p.0 - a.0) * dy - (p.1 - a.1) * dx).abs() / len
}

/// Adaptive de Casteljau subdivision; appends points after p0 (p0 must already be in `out`),
/// including p3 of each flat sub-segment, in order.
fn flatten_cubic(p0: P, p1: P, p2: P, p3: P, tol: f32, out: &mut Vec<Point>) {
    flatten_rec(p0, p1, p2, p3, tol, 0, out);
}

fn flatten_rec(p0: P, p1: P, p2: P, p3: P, tol: f32, depth: u8, out: &mut Vec<Point>) {
    if depth >= 18 || (dist_pt_line(p1, p0, p3) <= tol && dist_pt_line(p2, p0, p3) <= tol) {
        out.push(pt(p3.0, p3.1));
        return;
    }
    let p01 = mid(p0, p1);
    let p12 = mid(p1, p2);
    let p23 = mid(p2, p3);
    let p012 = mid(p01, p12);
    let p123 = mid(p12, p23);
    let p0123 = mid(p012, p123);
    flatten_rec(p0, p01, p012, p0123, tol, depth + 1, out);
    flatten_rec(p0123, p123, p23, p3, tol, depth + 1, out);
}

/// Split the cubic Bézier of the segment between two path nodes at parameter `t`, for inserting a
/// node mid-segment. Inputs are the segment's start anchor `a`, its outgoing handle `a_hout` and the
/// end node's incoming handle `b_hin` (both relative to their anchors), and the end anchor `b`.
/// Returns 10 floats: the new anchor `S`, then the three handle pairs that change — the start node's
/// new outgoing handle, the inserted node's in/out handles, and the end node's new incoming handle
/// (all relative to their respective anchors): `[Sx,Sy, aHoutX,aHoutY, mHinX,mHinY, mHoutX,mHoutY,
/// bHinX,bHinY]`. de Casteljau, so the curve is geometrically unchanged.
pub fn split_cubic(a: P, a_hout: P, b_hin: P, b: P, t: f32) -> [f32; 10] {
    let lerp = |p: P, q: P| (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
    let p0 = a;
    let p1 = (a.0 + a_hout.0, a.1 + a_hout.1);
    let p2 = (b.0 + b_hin.0, b.1 + b_hin.1);
    let p3 = b;
    let q0 = lerp(p0, p1);
    let q1 = lerp(p1, p2);
    let q2 = lerp(p2, p3);
    let r0 = lerp(q0, q1);
    let r1 = lerp(q1, q2);
    let s = lerp(r0, r1);
    [
        s.0, s.1, // new anchor
        q0.0 - p0.0, q0.1 - p0.1, // start node's new hout
        r0.0 - s.0, r0.1 - s.1, // inserted node's hin
        r1.0 - s.0, r1.1 - s.1, // inserted node's hout
        q2.0 - p3.0, q2.1 - p3.1, // end node's new hin
    ]
}

/// Ramer–Douglas–Peucker on a flat `[x0,y0,x1,y1,…]` polyline; returns the kept points, flat.
/// Used to reduce a dense freehand capture before it becomes a `path`.
pub fn simplify(xy: &[f32], tol: f32) -> Vec<f32> {
    let n = xy.len() / 2;
    if n < 3 {
        return xy.to_vec();
    }
    let pts: Vec<P> = (0..n).map(|i| (xy[2 * i], xy[2 * i + 1])).collect();
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    rdp(&pts, 0, n - 1, tol.max(1e-4), &mut keep);
    let mut out = Vec::new();
    for i in 0..n {
        if keep[i] {
            out.push(pts[i].0);
            out.push(pts[i].1);
        }
    }
    out
}

#[cfg(test)]
mod split_tests {
    use super::*;

    fn eval(p0: P, p1: P, p2: P, p3: P, t: f32) -> P {
        let mt = 1.0 - t;
        let (a, b, c, d) = (mt * mt * mt, 3.0 * mt * mt * t, 3.0 * mt * t * t, t * t * t);
        (a * p0.0 + b * p1.0 + c * p2.0 + d * p3.0, a * p0.1 + b * p1.1 + c * p2.1 + d * p3.1)
    }

    #[test]
    fn split_anchor_lies_on_the_curve() {
        // Symmetric arch; the t=0.5 split point must equal the curve evaluated at 0.5.
        let (a, a_hout, b_hin, b) = ((0.0, 0.0), (0.0, 2.0), (0.0, 2.0), (4.0, 0.0));
        let r = split_cubic(a, a_hout, b_hin, b, 0.5);
        let p1 = (a.0 + a_hout.0, a.1 + a_hout.1);
        let p2 = (b.0 + b_hin.0, b.1 + b_hin.1);
        let e = eval(a, p1, p2, b, 0.5);
        assert!((r[0] - e.0).abs() < 1e-4 && (r[1] - e.1).abs() < 1e-4, "split anchor off-curve: {r:?} vs {e:?}");
        assert!((r[0] - 2.0).abs() < 1e-4 && (r[1] - 1.5).abs() < 1e-4);
    }
}

fn rdp(pts: &[P], lo: usize, hi: usize, tol: f32, keep: &mut [bool]) {
    if hi <= lo + 1 {
        return;
    }
    let mut idx = lo;
    let mut max = 0.0;
    for i in (lo + 1)..hi {
        let d = dist_pt_line(pts[i], pts[lo], pts[hi]);
        if d > max {
            max = d;
            idx = i;
        }
    }
    if max > tol {
        keep[idx] = true;
        rdp(pts, lo, idx, tol, keep);
        rdp(pts, idx, hi, tol, keep);
    }
}
