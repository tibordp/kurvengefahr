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
/// fill reaches the edges while staying continuous. Density set by `spacing` (≈ cell size).
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
    let order = ((dim / spacing).log2().ceil() as i32).clamp(1, 7) as u32;
    let side = 1u32 << order;
    let step = dim / side as f32;

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

/// Pattern dispatch. 0 lines, 1 cross-hatch, 2 grid, 3 hilbert.
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
