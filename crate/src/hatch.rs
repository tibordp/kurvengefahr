//! Hatching: fill patterns for closed shapes (a pen plotter can't fill, so we simulate it with
//! lines). Each routine takes a closed polygon (the shape's tessellated outline) and emits
//! millimetre fill `Stroke`s, clipped to the polygon. Pure scalar Rust.

use crate::geom::{Point, Stroke};

type P = (f32, f32);

const ELLIPSE_TOL: f32 = 0.1;

fn pt(x: f32, y: f32) -> Point {
    Point { x, y, pressure: 1.0 }
}
fn stroke(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}
fn seg(a: P, b: P) -> Stroke {
    stroke(vec![pt(a.0, a.1), pt(b.0, b.1)])
}

/// Flat `[x0,y0,…]` → polygon vertices, dropping a trailing point that duplicates the first.
fn parse_poly(xy: &[f32]) -> Vec<P> {
    let mut v: Vec<P> = (0..xy.len() / 2).map(|i| (xy[2 * i], xy[2 * i + 1])).collect();
    if v.len() >= 2 {
        let f = v[0];
        let l = *v.last().unwrap();
        if (f.0 - l.0).abs() < 1e-6 && (f.1 - l.1).abs() < 1e-6 {
            v.pop();
        }
    }
    v
}

/// Even-odd ray-cast point-in-polygon.
fn inside(poly: &[P], x: f32, y: f32) -> bool {
    let mut c = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
            c = !c;
        }
        j = i;
    }
    c
}

/// Parallel fill lines at `angle_deg`, `spacing` mm apart, clipped to the polygon via a scanline.
/// Rotate the polygon so the lines become horizontal, scan, then rotate the segments back.
fn lines(poly: &[P], spacing: f32, angle_deg: f32, out: &mut Vec<Stroke>) {
    if poly.len() < 3 || spacing <= 1e-3 {
        return
    }
    let th = angle_deg.to_radians();
    let (fc, fs) = ((-th).cos(), (-th).sin()); // forward: rotate by −θ (lines → horizontal)
    let (rc, rs) = (th.cos(), th.sin()); // inverse: rotate by +θ
    let fwd = |p: P| (p.0 * fc - p.1 * fs, p.0 * fs + p.1 * fc);
    let inv = |p: P| (p.0 * rc - p.1 * rs, p.0 * rs + p.1 * rc);

    let rp: Vec<P> = poly.iter().map(|&p| fwd(p)).collect();
    let (mut ymin, mut ymax) = (f32::INFINITY, f32::NEG_INFINITY);
    for &(_, y) in &rp {
        ymin = ymin.min(y);
        ymax = ymax.max(y);
    }
    let n = rp.len();
    let mut y = ymin + spacing * 0.5;
    while y < ymax {
        let mut xs: Vec<f32> = Vec::new();
        let mut j = n - 1;
        for i in 0..n {
            let (xi, yi) = rp[i];
            let (xj, yj) = rp[j];
            if (yi > y) != (yj > y) {
                xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
            }
            j = i;
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            out.push(seg(inv((xs[k], y)), inv((xs[k + 1], y))));
            k += 2;
        }
        y += spacing;
    }
}

/// Hilbert d→(x,y) on a `side`×`side` grid (side a power of two). Standard bit-twiddle.
fn d2xy(side: u32, d: u32) -> (u32, u32) {
    let mut t = d;
    let (mut x, mut y) = (0u32, 0u32);
    let mut s = 1u32;
    while s < side {
        let rx = 1 & (t / 2);
        let ry = 1 & (t ^ rx);
        if ry == 0 {
            if rx == 1 {
                x = s - 1 - x;
                y = s - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        x += s * rx;
        y += s * ry;
        t /= 4;
        s *= 2;
    }
    (x, y)
}

/// Parameters t∈(0,1) where segment a→b crosses the polygon boundary, sorted and de-duplicated.
fn crossings(poly: &[P], a: P, b: P) -> Vec<f32> {
    let (rx, ry) = (b.0 - a.0, b.1 - a.1);
    let n = poly.len();
    let mut ts: Vec<f32> = Vec::new();
    let mut j = n - 1;
    for i in 0..n {
        let c = poly[j];
        let d = poly[i];
        let (sx, sy) = (d.0 - c.0, d.1 - c.1);
        let denom = rx * sy - ry * sx;
        if denom.abs() > 1e-12 {
            let (wx, wy) = (c.0 - a.0, c.1 - a.1);
            let t = (wx * sy - wy * sx) / denom;
            let u = (wx * ry - wy * rx) / denom;
            if t > 1e-6 && t < 1.0 - 1e-6 && u >= -1e-6 && u <= 1.0 + 1e-6 {
                ts.push(t);
            }
        }
        j = i;
    }
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    ts.dedup_by(|x, y| (*x - *y).abs() < 1e-5);
    ts
}

/// A Hilbert space-filling curve over the polygon's bbox, **clipped to the polygon boundary** so the
/// fill reaches the edges while staying continuous. Density set by `spacing` (the cell size).
fn hilbert(poly: &[P], spacing: f32, out: &mut Vec<Stroke>) {
    if poly.len() < 3 || spacing <= 1e-3 {
        return
    }
    let (mut xmin, mut ymin, mut xmax, mut ymax) =
        (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for &(x, y) in poly {
        xmin = xmin.min(x);
        ymin = ymin.min(y);
        xmax = xmax.max(x);
        ymax = ymax.max(y);
    }
    let dim = (xmax - xmin).max(ymax - ymin).max(1e-3);
    // The Hilbert curve needs a square power-of-two grid sized to the LONGER axis. Keep the cells
    // exactly `spacing` (so density honours the parameter independent of bbox size / aspect ratio)
    // and pick the smallest side that still covers `dim`; cells past the bbox are skipped cheaply
    // below, so a thin shape doesn't pay compute for the empty square above it. The cap (side ≤ 512
    // ⇒ ≥512·spacing of reach, well past any plotter bed) only bites on absurd size:spacing ratios,
    // where we coarsen to `dim/side` purely to keep coverage.
    let needed = (dim / spacing).ceil().max(1.0);
    let order = (needed.log2().ceil() as i32).clamp(1, 9) as u32;
    let side = 1u32 << order;
    let step = if side as f32 >= needed { spacing } else { dim / side as f32 };

    let pts: Vec<P> = (0..side * side)
        .map(|d| {
            let (gx, gy) = d2xy(side, d);
            (xmin + (gx as f32 + 0.5) * step, ymin + (gy as f32 + 0.5) * step)
        })
        .collect();
    let lerp = |a: P, b: P, t: f32| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);

    // Walk the curve, clipping each segment to the polygon. Each crossing splits the segment into
    // sub-spans; classify each span *independently* by its midpoint (no accumulated parity, so a
    // missed/extra crossing can't desync the run and join points across an outside gap). Inside
    // spans extend the current run; an outside span ends it.
    let mut run: Vec<Point> = Vec::new();
    let close = |run: &mut Vec<Point>, out: &mut Vec<Stroke>| {
        if run.len() >= 2 {
            out.push(stroke(std::mem::take(run)));
        } else {
            run.clear();
        }
    };
    for i in 1..pts.len() {
        let (a, b) = (pts[i - 1], pts[i]);
        // Cheap reject: a (axis-aligned) hop with both ends past the bbox max can't touch the
        // polygon — end the run without the O(edges) crossing test. Cells never sit below the min
        // (grid starts at xmin/ymin), so only the max sides overflow.
        if (a.0 > xmax && b.0 > xmax) || (a.1 > ymax && b.1 > ymax) {
            close(&mut run, out);
            continue
        }
        let mut bounds = vec![0.0_f32];
        bounds.extend(crossings(poly, a, b));
        bounds.push(1.0);
        for k in 0..bounds.len() - 1 {
            let (t0, t1) = (bounds[k], bounds[k + 1]);
            if t1 - t0 < 1e-9 {
                continue
            }
            let mid = lerp(a, b, 0.5 * (t0 + t1));
            if inside(poly, mid.0, mid.1) {
                let p0 = lerp(a, b, t0);
                let p1 = lerp(a, b, t1);
                let joins = run.last().is_some_and(|q| (q.x - p0.0).abs() < 1e-6 && (q.y - p0.1).abs() < 1e-6);
                if !joins {
                    run.push(pt(p0.0, p0.1));
                }
                run.push(pt(p1.0, p1.1));
            } else {
                close(&mut run, out);
            }
        }
    }
    close(&mut run, out);
}

/// Squared distance from point (px,py) to segment a→b.
fn pt_seg_dist2(px: f32, py: f32, a: P, b: P) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 <= 1e-12 { 0.0 } else { (((px - a.0) * dx + (py - a.1) * dy) / l2).clamp(0.0, 1.0) };
    let (cx, cy) = (a.0 + t * dx, a.1 + t * dy);
    let (ex, ey) = (px - cx, py - cy);
    ex * ex + ey * ey
}

/// Signed distance to the polygon boundary, **positive inside**.
fn signed_dist(poly: &[P], x: f32, y: f32) -> f32 {
    let n = poly.len();
    let mut best = f32::INFINITY;
    let mut j = n - 1;
    for i in 0..n {
        let d2 = pt_seg_dist2(x, y, poly[j], poly[i]);
        if d2 < best {
            best = d2;
        }
        j = i;
    }
    let d = best.sqrt();
    if inside(poly, x, y) { d } else { -d }
}

/// Marching-squares cell at iso-level `l`. Corners are bottom-left/right, top-right/left distance
/// values; emits the 0–2 contour segments crossing the cell, with saddles resolved by the centre.
#[allow(clippy::too_many_arguments)]
fn march_cell(l: f32, bl: f32, br: f32, tr: f32, tl: f32, x0: f32, y0: f32, x1: f32, y1: f32, out: &mut Vec<(P, P)>) {
    let mut idx = 0u8;
    if bl >= l { idx |= 1 }
    if br >= l { idx |= 2 }
    if tr >= l { idx |= 4 }
    if tl >= l { idx |= 8 }
    if idx == 0 || idx == 15 {
        return
    }
    // Linear interpolation of the iso-crossing along each cell edge.
    let e_bottom = || (x0 + (l - bl) / (br - bl) * (x1 - x0), y0);
    let e_right = || (x1, y0 + (l - br) / (tr - br) * (y1 - y0));
    let e_top = || (x1 + (l - tr) / (tl - tr) * (x0 - x1), y1);
    let e_left = || (x0, y1 + (l - tl) / (bl - tl) * (y0 - y1));
    let center = (bl + br + tr + tl) * 0.25;
    match idx {
        1 | 14 => out.push((e_left(), e_bottom())),
        2 | 13 => out.push((e_bottom(), e_right())),
        3 | 12 => out.push((e_left(), e_right())),
        4 | 11 => out.push((e_right(), e_top())),
        6 | 9 => out.push((e_bottom(), e_top())),
        7 | 8 => out.push((e_top(), e_left())),
        5 => {
            // bl,tr inside on a diagonal: centre tells us whether they're joined or isolated.
            if center >= l {
                out.push((e_bottom(), e_right()));
                out.push((e_top(), e_left()));
            } else {
                out.push((e_left(), e_bottom()));
                out.push((e_right(), e_top()));
            }
        }
        10 => {
            if center >= l {
                out.push((e_bottom(), e_left()));
                out.push((e_right(), e_top()));
            } else {
                out.push((e_bottom(), e_right()));
                out.push((e_top(), e_left()));
            }
        }
        _ => {}
    }
}

/// Stitch a marching-squares segment soup into continuous polylines by endpoint matching (adjacent
/// cells share an exact iso-point, so a coarse quantization key reliably joins them).
fn stitch(segs: &[(P, P)], tol: f32) -> Vec<Vec<P>> {
    use std::collections::HashMap;
    let tol = tol.max(1e-4);
    let key = |p: P| ((p.0 / tol).round() as i64, (p.1 / tol).round() as i64);
    let mut adj: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, &(a, b)) in segs.iter().enumerate() {
        adj.entry(key(a)).or_default().push(i);
        adj.entry(key(b)).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    // Find an unused segment touching `p`; return its far endpoint.
    let step = |p: P, used: &mut [bool]| -> Option<P> {
        let list = adj.get(&key(p))?;
        for &i in list {
            if !used[i] {
                used[i] = true;
                let (a, b) = segs[i];
                return Some(if key(a) == key(p) { b } else { a })
            }
        }
        None
    };
    let mut polylines = Vec::new();
    for s in 0..segs.len() {
        if used[s] {
            continue
        }
        used[s] = true;
        let (a, b) = segs[s];
        let mut chain = std::collections::VecDeque::from([a, b]);
        while let Some(nx) = step(*chain.back().unwrap(), &mut used) {
            chain.push_back(nx);
        }
        while let Some(nx) = step(*chain.front().unwrap(), &mut used) {
            chain.push_front(nx);
        }
        polylines.push(chain.into_iter().collect());
    }
    polylines
}

/// Concentric fill for an **arbitrary** polygon: iso-distance contours of the inward distance field
/// (rings at `spacing`, `2·spacing`, …), so it works on concave shapes and splits into multiple
/// rings where the medial axis branches. (Rect/ellipse use the exact parametric `concentric`.)
fn concentric_poly(poly: &[P], spacing: f32, out: &mut Vec<Stroke>) {
    if poly.len() < 3 || spacing <= 1e-3 {
        return
    }
    const MAX_CELLS: usize = 400;
    let (mut xmin, mut ymin, mut xmax, mut ymax) =
        (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for &(x, y) in poly {
        xmin = xmin.min(x);
        ymin = ymin.min(y);
        xmax = xmax.max(x);
        ymax = ymax.max(y);
    }
    let ext_x = (xmax - xmin).max(1e-3);
    let ext_y = (ymax - ymin).max(1e-3);
    // Sample finer than the spacing so contours stay smooth; cap the grid so big shapes stay fast.
    let target = (spacing / 3.0).max(1e-3);
    let ncx = ((ext_x / target).ceil() as usize).clamp(1, MAX_CELLS);
    let ncy = ((ext_y / target).ceil() as usize).clamp(1, MAX_CELLS);
    let (sx, sy) = (ext_x / ncx as f32, ext_y / ncy as f32);
    let (nodes_x, nodes_y) = (ncx + 1, ncy + 1);

    let mut field = vec![0.0_f32; nodes_x * nodes_y];
    let mut maxd = 0.0_f32;
    for jy in 0..nodes_y {
        let y = ymin + jy as f32 * sy;
        for ix in 0..nodes_x {
            let d = signed_dist(poly, xmin + ix as f32 * sx, y);
            field[jy * nodes_x + ix] = d;
            maxd = maxd.max(d);
        }
    }

    let tol = sx.min(sy) * 0.1;
    let mut level = spacing;
    while level < maxd {
        let mut segs: Vec<(P, P)> = Vec::new();
        for jy in 0..ncy {
            let (y0, y1) = (ymin + jy as f32 * sy, ymin + (jy + 1) as f32 * sy);
            for ix in 0..ncx {
                let (x0, x1) = (xmin + ix as f32 * sx, xmin + (ix + 1) as f32 * sx);
                march_cell(
                    level,
                    field[jy * nodes_x + ix],
                    field[jy * nodes_x + ix + 1],
                    field[(jy + 1) * nodes_x + ix + 1],
                    field[(jy + 1) * nodes_x + ix],
                    x0,
                    y0,
                    x1,
                    y1,
                    &mut segs,
                );
            }
        }
        for line in stitch(&segs, tol) {
            if line.len() >= 2 {
                out.push(stroke(line.into_iter().map(|(x, y)| pt(x, y)).collect()));
            }
        }
        level += spacing;
    }
}

/// Pattern dispatch. 0 lines, 1 cross-hatch, 2 grid, 3 hilbert, 4 concentric (arbitrary polygon).
pub fn fill(xy: &[f32], pattern: u32, spacing: f32, angle_deg: f32) -> Vec<Stroke> {
    let poly = parse_poly(xy);
    let mut out = Vec::new();
    match pattern {
        0 => lines(&poly, spacing, angle_deg, &mut out),
        1 => {
            lines(&poly, spacing, angle_deg, &mut out);
            lines(&poly, spacing, angle_deg + 90.0, &mut out);
        }
        2 => {
            lines(&poly, spacing, 0.0, &mut out);
            lines(&poly, spacing, 90.0, &mut out);
        }
        3 => hilbert(&poly, spacing, &mut out),
        4 => concentric_poly(&poly, spacing, &mut out),
        _ => {}
    }
    out
}

/// Exact parametric concentric rings. `kind 0` = rect (a=w, b=h); `kind 1` = ellipse (a=rx, b=ry).
pub fn concentric(kind: u32, a: f32, b: f32, spacing: f32) -> Vec<Stroke> {
    let mut out = Vec::new();
    if spacing <= 1e-3 {
        return out
    }
    let mut k = 1.0_f32;
    loop {
        let d = k * spacing;
        if kind == 0 {
            let (w, h) = (a - 2.0 * d, b - 2.0 * d);
            if w <= spacing * 0.25 || h <= spacing * 0.25 {
                break
            }
            for mut s in crate::shapes::rect(w, h, 0.0) {
                for p in &mut s.points {
                    p.x += d;
                    p.y += d;
                }
                out.push(s);
            }
        } else {
            let (rx, ry) = (a - d, b - d);
            if rx <= spacing * 0.25 || ry <= spacing * 0.25 {
                break
            }
            // Ring tessellation mirrors shapes::ellipse so density matches the outline.
            let r = rx.max(ry);
            let nseg = (std::f32::consts::PI / (2.0 * ELLIPSE_TOL / r).sqrt())
                .ceil()
                .clamp(16.0, 512.0) as usize;
            let mut points = Vec::with_capacity(nseg + 1);
            for i in 0..=nseg {
                let t = (i as f32 / nseg as f32) * std::f32::consts::TAU;
                points.push(pt(rx * t.cos(), ry * t.sin()));
            }
            out.push(stroke(points));
        }
        k += 1.0;
    }
    out
}

#[cfg(test)]
mod concentric_tests {
    use super::*;
    #[test]
    fn square_makes_nested_closed_rings() {
        // 20x20 square, spacing 3 -> expect rings inset by ~3,6,9 (3 rings before collapse at 10).
        let sq: Vec<P> = vec![(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)];
        let mut out = Vec::new();
        concentric_poly(&sq, 3.0, &mut out);
        assert!(out.len() >= 2, "expected multiple rings, got {}", out.len());
        for s in &out {
            // Closed loop: first ~ last.
            let (f, l) = (s.points.first().unwrap(), s.points.last().unwrap());
            assert!((f.x - l.x).abs() < 0.5 && (f.y - l.y).abs() < 0.5, "ring not closed");
            // Every ring point is strictly inside the square.
            for p in &s.points {
                assert!(p.x > -0.1 && p.x < 20.1 && p.y > -0.1 && p.y < 20.1, "point outside");
            }
        }
        // Innermost ring is well inside (>= ~2mm from edges given spacing 3).
        let any_inner = out.iter().any(|s| s.points.iter().all(|p| p.x > 2.0 && p.x < 18.0 && p.y > 2.0 && p.y < 18.0));
        assert!(any_inner, "no inset ring found");
    }

    /// The Hilbert cell pitch must equal `spacing`, independent of the shape's bbox. Adjacent
    /// curve points sit one cell apart, so the dominant consecutive-point distance is the pitch.
    fn dominant_pitch(strokes: &[Stroke]) -> f32 {
        let mut max_d = 0.0_f32;
        for s in strokes {
            for w in s.points.windows(2) {
                let d = ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt();
                max_d = max_d.max(d);
            }
        }
        max_d // full-cell hops are the longest steps; clipped sub-spans are shorter.
    }

    #[test]
    fn hilbert_pitch_matches_spacing_regardless_of_aspect_ratio() {
        let rect = |w: f32, h: f32| -> Vec<P> { vec![(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)] };
        // Square sizes, plus increasingly elongated boxes at a tight spacing — the long axis here
        // (up to 400mm) used to blow past the old side≤128 cap and inflate the pitch.
        let cases: &[(f32, f32, f32)] =
            &[(18.0, 18.0, 2.0), (73.0, 73.0, 2.0), (40.0, 8.0, 1.0), (200.0, 20.0, 1.0), (400.0, 20.0, 1.0)];
        for &(w, h, spacing) in cases {
            let mut out = Vec::new();
            hilbert(&rect(w, h), spacing, &mut out);
            let pitch = dominant_pitch(&out);
            assert!((pitch - spacing).abs() < 1e-3, "{w}x{h} sp {spacing}: pitch {pitch} != {spacing}");
        }
    }
}
