//! Hatching: fill patterns for closed shapes (a pen plotter can't fill, so we simulate it with
//! lines). Each routine takes a closed polygon (the shape's tessellated outline) and emits
//! millimetre fill `Stroke`s, clipped to the polygon. Pure scalar Rust.

use crate::geom::{Point, Stroke};
use crate::poly::{crossings, inside_multi, parse_polys, pt, P};

const ELLIPSE_TOL: f32 = crate::tess::ELLIPSE_FILL_TOL;

fn stroke(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}
fn seg(a: P, b: P) -> Stroke {
    stroke(vec![pt(a.0, a.1), pt(b.0, b.1)])
}

/// Bounding box over all rings' vertices.
fn bbox(rings: &[Vec<P>]) -> (f32, f32, f32, f32) {
    let (mut xmin, mut ymin, mut xmax, mut ymax) =
        (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for ring in rings {
        for &(x, y) in ring {
            xmin = xmin.min(x);
            ymin = ymin.min(y);
            xmax = xmax.max(x);
            ymax = ymax.max(y);
        }
    }
    (xmin, ymin, xmax, ymax)
}

/// Parallel fill lines at `angle_deg`, `spacing` mm apart, clipped to all rings via a scanline.
/// Rotate the rings so the lines become horizontal, gather every ring's edge crossings on each
/// scanline, sort, and emit alternating in/out pairs (even-odd → holes fall out for free), then
/// rotate the segments back.
fn lines(rings: &[Vec<P>], spacing: f32, angle_deg: f32, out: &mut Vec<Stroke>) {
    if rings.iter().all(|r| r.len() < 3) || spacing <= 1e-3 {
        return
    }
    let th = angle_deg.to_radians();
    let (fc, fs) = ((-th).cos(), (-th).sin()); // forward: rotate by −θ (lines → horizontal)
    let (rc, rs) = (th.cos(), th.sin()); // inverse: rotate by +θ
    let fwd = |p: P| (p.0 * fc - p.1 * fs, p.0 * fs + p.1 * fc);
    let inv = |p: P| (p.0 * rc - p.1 * rs, p.0 * rs + p.1 * rc);

    let rr: Vec<Vec<P>> = rings.iter().map(|r| r.iter().map(|&p| fwd(p)).collect()).collect();
    let (mut ymin, mut ymax) = (f32::INFINITY, f32::NEG_INFINITY);
    for ring in &rr {
        for &(_, y) in ring {
            ymin = ymin.min(y);
            ymax = ymax.max(y);
        }
    }
    let mut y = ymin + spacing * 0.5;
    while y < ymax {
        let mut xs: Vec<f32> = Vec::new();
        for rp in &rr {
            let n = rp.len();
            if n < 3 {
                continue
            }
            let mut j = n - 1;
            for i in 0..n {
                let (xi, yi) = rp[i];
                let (xj, yj) = rp[j];
                if (yi > y) != (yj > y) {
                    xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
                }
                j = i;
            }
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

/// A Hilbert space-filling curve over the polygon's bbox, **clipped to the polygon boundary** so the
/// fill reaches the edges while staying continuous. Density set by `spacing` (the cell size).
fn hilbert(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if rings.iter().all(|r| r.len() < 3) || spacing <= 1e-3 {
        return
    }
    let (xmin, ymin, xmax, ymax) = bbox(rings);
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
        bounds.extend(crossings(rings, a, b));
        bounds.push(1.0);
        for k in 0..bounds.len() - 1 {
            let (t0, t1) = (bounds[k], bounds[k + 1]);
            if t1 - t0 < 1e-9 {
                continue
            }
            let mid = lerp(a, b, 0.5 * (t0 + t1));
            if inside_multi(rings, mid.0, mid.1) {
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

/// Signed distance to the nearest edge of any ring, **positive inside** the even-odd region.
fn signed_dist(rings: &[Vec<P>], x: f32, y: f32) -> f32 {
    let mut best = f32::INFINITY;
    for poly in rings {
        let n = poly.len();
        if n < 3 {
            continue
        }
        let mut j = n - 1;
        for i in 0..n {
            let d2 = pt_seg_dist2(x, y, poly[j], poly[i]);
            if d2 < best {
                best = d2;
            }
            j = i;
        }
    }
    let d = best.sqrt();
    if inside_multi(rings, x, y) { d } else { -d }
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
fn concentric_poly(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if rings.iter().all(|r| r.len() < 3) || spacing <= 1e-3 {
        return
    }
    const MAX_CELLS: usize = 400;
    let (xmin, ymin, xmax, ymax) = bbox(rings);
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
            let d = signed_dist(rings, xmin + ix as f32 * sx, y);
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

/// Deterministic 0..1 hash for jittered placement (stipple / voronoi seeds / truchet orientation).
fn rand01(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374761393) ^ (y as u32).wrapping_mul(668265263);
    h ^= h >> 13;
    h = h.wrapping_mul(1274126177);
    h ^= h >> 16;
    h as f32 / u32::MAX as f32
}

/// Split a polyline into the sub-polylines lying inside the even-odd region of `rings`, appending
/// each as a stroke. (Same clip the Hilbert fill uses, factored out for the line-art fills.)
fn clip_to_rings(rings: &[Vec<P>], pts: &[P], out: &mut Vec<Stroke>) {
    if pts.len() < 2 {
        return
    }
    let lerp = |a: P, b: P, t: f32| (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
    let mut run: Vec<Point> = Vec::new();
    let close = |run: &mut Vec<Point>, out: &mut Vec<Stroke>| {
        if run.len() >= 2 {
            out.push(stroke(std::mem::take(run)));
        } else {
            run.clear();
        }
    };
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let mut bounds = vec![0.0_f32];
        bounds.extend(crossings(rings, a, b));
        bounds.push(1.0);
        for k in 0..bounds.len() - 1 {
            let (t0, t1) = (bounds[k], bounds[k + 1]);
            if t1 - t0 < 1e-9 {
                continue
            }
            let mid = lerp(a, b, 0.5 * (t0 + t1));
            if inside_multi(rings, mid.0, mid.1) {
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

/// Stipple: jittered dots (tiny circles) on a grid, kept where inside the region.
fn stipple(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return
    }
    let (x0, y0, x1, y1) = bbox(rings);
    let r = (spacing * 0.16).max(0.05);
    let mut gy = 0;
    let mut y = y0;
    while y <= y1 {
        let mut gx = 0;
        let mut x = x0;
        while x <= x1 {
            let (px, py) = (x + (rand01(gx, gy * 7 + 1) - 0.5) * spacing * 0.6, y + (rand01(gx * 7 + 3, gy) - 0.5) * spacing * 0.6);
            if inside_multi(rings, px, py) {
                let n = 8;
                let pts = (0..=n).map(|i| {
                    let t = i as f32 / n as f32 * std::f32::consts::TAU;
                    pt(px + r * t.cos(), py + r * t.sin())
                });
                out.push(stroke(pts.collect()));
            }
            x += spacing;
            gx += 1;
        }
        y += spacing;
        gy += 1;
    }
}

/// Rotate rings by −θ so a horizontal sweep yields lines at angle θ; returns (rotated rings, fns).
fn rotated(rings: &[Vec<P>], angle_deg: f32) -> (Vec<Vec<P>>, impl Fn(P) -> P) {
    let th = angle_deg.to_radians();
    let (fc, fs) = ((-th).cos(), (-th).sin());
    let (rc, rs) = (th.cos(), th.sin());
    let rr = rings.iter().map(|r| r.iter().map(|&p| (p.0 * fc - p.1 * fs, p.0 * fs + p.1 * fc)).collect()).collect();
    (rr, move |p: P| (p.0 * rc - p.1 * rs, p.0 * rs + p.1 * rc))
}

/// Scribble: sinusoidally-wiggled scanlines, clipped to the region (hand-drawn shading).
fn scribble(rings: &[Vec<P>], spacing: f32, angle_deg: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return
    }
    let (rr, inv) = rotated(rings, angle_deg);
    let (x0, y0, x1, y1) = bbox(&rr);
    let amp = spacing * 0.42;
    let freq = std::f32::consts::TAU / (spacing * 1.6);
    let step = (spacing * 0.25).max(0.3);
    let mut y = y0 + spacing * 0.5;
    let mut row = 0;
    while y < y1 {
        let phase = row as f32 * 1.7;
        let mut pts: Vec<P> = Vec::new();
        let mut x = x0;
        while x <= x1 {
            pts.push(inv((x, y + amp * (x * freq + phase).sin())));
            x += step;
        }
        clip_to_rings(rings, &pts, out);
        y += spacing;
        row += 1;
    }
}

/// Variable-density hatch: parallel lines whose spacing grows across the sweep, a tonal gradient.
fn gradient(rings: &[Vec<P>], spacing: f32, angle_deg: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return
    }
    let (rr, inv) = rotated(rings, angle_deg);
    let (_, ymin, _, ymax) = bbox(&rr);
    if ymax <= ymin {
        return
    }
    let mut tmp: Vec<Stroke> = Vec::new();
    let mut y = ymin + spacing * 0.5;
    while y < ymax {
        // One scanline: clip the infinite line y=const to the rings via even-odd crossing pairs.
        let f = (y - ymin) / (ymax - ymin);
        let mut xs: Vec<f32> = Vec::new();
        for ring in &rr {
            let n = ring.len();
            if n < 3 {
                continue
            }
            let mut j = n - 1;
            for i in 0..n {
                let (xi, yi) = ring[i];
                let (xj, yj) = ring[j];
                if (yi > y) != (yj > y) {
                    xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
                }
                j = i;
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mut k = 0;
        while k + 1 < xs.len() {
            tmp.push(stroke(vec![pt_p(inv((xs[k], y))), pt_p(inv((xs[k + 1], y)))]));
            k += 2;
        }
        y += spacing * (0.45 + 2.6 * f); // dense at one end, sparse at the other
    }
    out.extend(tmp);
}

fn pt_p(p: P) -> Point {
    pt(p.0, p.1)
}

/// Voronoi fill: jittered seeds over the bbox, Delaunay dual edges clipped to the region.
fn voronoi_fill(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return
    }
    let (x0, y0, x1, y1) = bbox(rings);
    let cols = ((x1 - x0) / spacing).max(1.0).ceil() as i32;
    let rows = ((y1 - y0) / spacing).max(1.0).ceil() as i32;
    let mut seeds: Vec<delaunator::Point> = Vec::new();
    for gy in 0..=rows {
        for gx in 0..=cols {
            let sx = x0 + (gx as f32 + rand01(gx, gy * 13 + 1) - 0.5) * spacing;
            let sy = y0 + (gy as f32 + rand01(gx * 13 + 7, gy) - 0.5) * spacing;
            seeds.push(delaunator::Point { x: sx as f64, y: sy as f64 });
        }
    }
    if seeds.len() < 3 {
        return
    }
    let tri = delaunator::triangulate(&seeds);
    let ntri = tri.triangles.len() / 3;
    let circ = |a: &delaunator::Point, b: &delaunator::Point, c: &delaunator::Point| -> P {
        let d = 2.0 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
        if d.abs() < 1e-12 {
            return (((a.x + b.x + c.x) / 3.0) as f32, ((a.y + b.y + c.y) / 3.0) as f32);
        }
        let (a2, b2, c2) = (a.x * a.x + a.y * a.y, b.x * b.x + b.y * b.y, c.x * c.x + c.y * c.y);
        let ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
        let uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
        (ux as f32, uy as f32)
    };
    let cc: Vec<P> = (0..ntri)
        .map(|t| circ(&seeds[tri.triangles[3 * t]], &seeds[tri.triangles[3 * t + 1]], &seeds[tri.triangles[3 * t + 2]]))
        .collect();
    for e in 0..tri.halfedges.len() {
        let o = tri.halfedges[e];
        if o != delaunator::EMPTY && e < o {
            clip_to_rings(rings, &[cc[e / 3], cc[o / 3]], out);
        }
    }
}

/// Truchet fill: a grid of randomly-oriented quarter-arc tiles clipped to the region.
fn truchet_fill(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    let s = spacing.max(1.0);
    let (x0, y0, x1, y1) = bbox(rings);
    let cols = (((x1 - x0) / s).ceil() as i32).max(1);
    let rows = (((y1 - y0) / s).ceil() as i32).max(1);
    let arc = |cx: f32, cy: f32, a0: f32, a1: f32| -> Vec<P> {
        (0..=10).map(|i| {
            let t = a0 + (a1 - a0) * i as f32 / 10.0;
            (cx + s * 0.5 * t.cos(), cy + s * 0.5 * t.sin())
        }).collect()
    };
    use std::f32::consts::{FRAC_PI_2, PI};
    for gy in 0..rows {
        for gx in 0..cols {
            let (ox, oy) = (x0 + gx as f32 * s, y0 + gy as f32 * s);
            let (a, b) = if rand01(gx, gy) > 0.5 {
                (arc(ox, oy, 0.0, FRAC_PI_2), arc(ox + s, oy + s, PI, PI + FRAC_PI_2))
            } else {
                (arc(ox + s, oy, FRAC_PI_2, PI), arc(ox, oy + s, -FRAC_PI_2, 0.0))
            };
            clip_to_rings(rings, &a, out);
            clip_to_rings(rings, &b, out);
        }
    }
}

/// Archimedean spiral fill: one continuous spiral from the bbox centre, arms `spacing` mm apart,
/// clipped to the region (a single-stroke tonal fill that plots with almost no pen-up travel).
fn spiral_fill(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return
    }
    let (x0, y0, x1, y1) = bbox(rings);
    let (cx, cy) = ((x0 + x1) * 0.5, (y0 + y1) * 0.5);
    // Reach the far corner so the spiral covers the whole shape.
    let rmax = (x1 - cx).hypot(y1 - cy).max((cx - x0).hypot(cy - y0)).max(1e-3);
    let b = spacing / std::f32::consts::TAU; // radial growth per radian → `spacing` per turn
    // Step the angle so the arc length between samples stays ~a quarter of the spacing (smooth arms).
    let pts: Vec<P> = {
        let mut v = Vec::new();
        let mut th = 0.0f32;
        loop {
            let r = b * th;
            if r > rmax {
                break
            }
            v.push((cx + r * th.cos(), cy + r * th.sin()));
            // dθ so r·dθ ≈ spacing/4, clamped so the tight centre doesn't spin forever.
            let dth = (spacing * 0.25 / r.max(spacing * 0.1)).clamp(0.03, 0.5);
            th += dth;
        }
        v
    };
    clip_to_rings(rings, &pts, out);
}

/// Maze fill: a perfect maze (recursive-backtracker spanning tree) over a `spacing`-mm cell grid,
/// its walls clipped to the region. Deterministic (position-hashed choices), like the other
/// grid fills. Draws the walls, not the passages, so it reads as a maze.
fn maze_fill(rings: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    let s = spacing.max(1.0);
    let (x0, y0, x1, y1) = bbox(rings);
    let cols = (((x1 - x0) / s).ceil() as i32).max(1);
    let rows = (((y1 - y0) / s).ceil() as i32).max(1);
    let (nc, nr) = (cols as usize, rows as usize);
    let idx = |gx: usize, gy: usize| gy * nc + gx;
    // `open_right[c]` = passage between cell c and its right neighbour; `open_down[c]` = below.
    let mut open_right = vec![false; nc * nr];
    let mut open_down = vec![false; nc * nr];
    let mut visited = vec![false; nc * nr];

    // Iterative randomized DFS. Choices are hashed on (cell, step) so the maze is fully determined.
    let mut stack: Vec<(usize, usize)> = vec![(0, 0)];
    visited[idx(0, 0)] = true;
    let mut step = 0i32;
    while let Some(&(cx, cy)) = stack.last() {
        // Unvisited orthogonal neighbours: (nx, ny, dir) with dir 0=right 1=left 2=down 3=up.
        let mut nb: Vec<(usize, usize, u8)> = Vec::with_capacity(4);
        if cx + 1 < nc && !visited[idx(cx + 1, cy)] {
            nb.push((cx + 1, cy, 0))
        }
        if cx > 0 && !visited[idx(cx - 1, cy)] {
            nb.push((cx - 1, cy, 1))
        }
        if cy + 1 < nr && !visited[idx(cx, cy + 1)] {
            nb.push((cx, cy + 1, 2))
        }
        if cy > 0 && !visited[idx(cx, cy - 1)] {
            nb.push((cx, cy - 1, 3))
        }
        if nb.is_empty() {
            stack.pop();
            continue
        }
        step += 1;
        let pick = (rand01(step, (cx as i32) * 73856 ^ (cy as i32) * 19349) * nb.len() as f32) as usize;
        let (nx, ny, dir) = nb[pick.min(nb.len() - 1)];
        match dir {
            0 => open_right[idx(cx, cy)] = true,
            1 => open_right[idx(nx, ny)] = true,
            2 => open_down[idx(cx, cy)] = true,
            _ => open_down[idx(nx, ny)] = true,
        }
        visited[idx(nx, ny)] = true;
        stack.push((nx, ny));
    }

    let px = |gx: i32| x0 + gx as f32 * s;
    let py = |gy: i32| y0 + gy as f32 * s;
    // Vertical walls at every column boundary 0..=cols; present unless it's an internal passage.
    for gx in 0..=cols {
        for gy in 0..rows {
            let present = gx == 0 || gx == cols || !open_right[idx((gx - 1) as usize, gy as usize)];
            if present {
                clip_to_rings(rings, &[(px(gx), py(gy)), (px(gx), py(gy + 1))], out);
            }
        }
    }
    // Horizontal walls at every row boundary 0..=rows.
    for gy in 0..=rows {
        for gx in 0..cols {
            let present = gy == 0 || gy == rows || !open_down[idx(gx as usize, (gy - 1) as usize)];
            if present {
                clip_to_rings(rings, &[(px(gx), py(gy)), (px(gx + 1), py(gy))], out);
            }
        }
    }
}

/// Pattern dispatch over one or more rings (filled together, even-odd → holes). 0 lines,
/// 1 cross-hatch, 2 grid, 3 hilbert, 4 concentric, 5 stipple, 6 scribble, 7 gradient, 8 voronoi,
/// 9 truchet, 10 spiral, 11 maze.
pub fn fill(xy: &[f32], ring_starts: &[u32], pattern: u32, spacing: f32, angle_deg: f32) -> Vec<Stroke> {
    let rings = parse_polys(xy, ring_starts);
    let mut out = Vec::new();
    match pattern {
        0 => lines(&rings, spacing, angle_deg, &mut out),
        1 => {
            lines(&rings, spacing, angle_deg, &mut out);
            lines(&rings, spacing, angle_deg + 90.0, &mut out);
        }
        2 => {
            lines(&rings, spacing, 0.0, &mut out);
            lines(&rings, spacing, 90.0, &mut out);
        }
        3 => hilbert(&rings, spacing, &mut out),
        4 => concentric_poly(&rings, spacing, &mut out),
        5 => stipple(&rings, spacing, &mut out),
        6 => scribble(&rings, spacing, angle_deg, &mut out),
        7 => gradient(&rings, spacing, angle_deg, &mut out),
        8 => voronoi_fill(&rings, spacing, &mut out),
        9 => truchet_fill(&rings, spacing, &mut out),
        10 => spiral_fill(&rings, spacing, &mut out),
        11 => maze_fill(&rings, spacing, &mut out),
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
        concentric_poly(&[sq], 3.0, &mut out);
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
    fn new_fills_produce_strokes() {
        // A 30×30 square; each new pattern code should fill it with strokes, clipped to the shape.
        let sq: Vec<f32> = vec![0.0, 0.0, 30.0, 0.0, 30.0, 30.0, 0.0, 30.0];
        let starts = vec![0u32, 4];
        for code in [5u32, 6, 7, 8, 9, 10, 11] {
            let out = fill(&sq, &starts, code, 2.0, 45.0);
            assert!(!out.is_empty(), "fill pattern {code} produced nothing");
        }
    }

    #[test]
    fn even_odd_punches_a_hole() {
        // A 20×20 square with a concentric 10×10 hole. Even-odd parity across both rings must leave
        // the hole unfilled: no horizontal line segment may span the centre (10,10).
        let outer: Vec<P> = vec![(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)];
        let inner: Vec<P> = vec![(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)];
        let mut out = Vec::new();
        lines(&[outer, inner], 2.0, 0.0, &mut out);
        assert!(!out.is_empty(), "expected fill in the annulus");
        for s in &out {
            let (a, b) = (s.points[0], s.points[1]);
            let ymid = (a.y + b.y) * 0.5;
            if (ymid - 10.0).abs() < 1.0 {
                let (lo, hi) = (a.x.min(b.x), a.x.max(b.x));
                assert!(!(lo < 10.0 && hi > 10.0), "fill crosses the hole at y={ymid}");
            }
        }
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
            hilbert(&[rect(w, h)], spacing, &mut out);
            let pitch = dominant_pitch(&out);
            assert!((pitch - spacing).abs() < 1e-3, "{w}x{h} sp {spacing}: pitch {pitch} != {spacing}");
        }
    }
}
