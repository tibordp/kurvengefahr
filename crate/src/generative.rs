//! Generative primitives: parametric pattern generators that take only knobs (no image/text) and
//! emit pen strokes, fit to a width×height box in element-local mm. One `generative` element picks a
//! `kind`; this dispatches. Deterministic per `seed`. Five kinds: spirograph, L-system, Truchet
//! tiles, Voronoi, and a noise flow field.

use crate::geom::{Point, Stroke};
use std::f32::consts::TAU;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Params {
    kind: String,
    seed: u32,
    width: f32,
    height: f32,
    // spirograph
    outer_r: f32,
    inner_r: f32,
    pen_offset: f32,
    // l-system
    preset: String,
    iterations: u32,
    angle: f32,
    // truchet
    cell: f32,
    style: String,
    // voronoi
    points: u32,
    // flow field
    lines: u32,
    steps: u32,
    noise_scale: f32,
}
impl Default for Params {
    fn default() -> Self {
        Self {
            kind: "spirograph".into(),
            seed: 1,
            width: 120.0,
            height: 120.0,
            outer_r: 50.0,
            inner_r: 30.0,
            pen_offset: 18.0,
            preset: "koch".into(),
            iterations: 4,
            angle: 90.0,
            cell: 12.0,
            style: "arcs".into(),
            points: 140,
            lines: 220,
            steps: 220,
            noise_scale: 0.04,
        }
    }
}

pub fn generate(json: &str) -> Vec<Stroke> {
    let p: Params = serde_json::from_str(json).unwrap_or_default();
    if p.width <= 0.0 || p.height <= 0.0 {
        return Vec::new();
    }
    match p.kind.as_str() {
        "lsystem" => lsystem(&p),
        "truchet" => truchet(&p),
        "voronoi" => voronoi(&p),
        "flow" => flow(&p),
        _ => spirograph(&p),
    }
}

// ---- helpers ------------------------------------------------------------------------------------

struct Rng(u32);
impl Rng {
    fn new(s: u32) -> Self {
        Rng(s.max(1).wrapping_mul(2654435761).max(1))
    }
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn f32(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }
}

fn pt(x: f32, y: f32) -> Point {
    Point { x, y, pressure: 1.0 }
}
fn poly(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}

/// Scale a set of polylines to fit a box `[0,w]×[0,h]` with a margin, preserving aspect, centred.
fn fit(polys: Vec<Vec<(f32, f32)>>, w: f32, h: f32) -> Vec<Stroke> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for pl in &polys {
        for &(x, y) in pl {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    if !x0.is_finite() || x1 <= x0 || y1 <= y0 {
        return Vec::new();
    }
    let m = 0.06 * w.min(h);
    let s = ((w - 2.0 * m) / (x1 - x0)).min((h - 2.0 * m) / (y1 - y0));
    let (ox, oy) = (w * 0.5 - s * (x0 + x1) * 0.5, h * 0.5 - s * (y0 + y1) * 0.5);
    polys
        .into_iter()
        .filter(|pl| pl.len() >= 2)
        .map(|pl| poly(pl.into_iter().map(|(x, y)| pt(ox + x * s, oy + y * s)).collect()))
        .collect()
}

// ---- spirograph (hypotrochoid) ------------------------------------------------------------------

fn gcd(a: u32, b: u32) -> u32 {
    if b == 0 {
        a.max(1)
    } else {
        gcd(b, a % b)
    }
}

fn spirograph(p: &Params) -> Vec<Stroke> {
    let big = p.outer_r.abs().max(1.0);
    let r = p.inner_r.abs().clamp(0.5, big - 0.1);
    let d = p.pen_offset;
    // Revolutions until the curve closes = r / gcd(R, r) (using rounded integers for the period).
    let revs = (r.round() as u32).max(1) / gcd(big.round() as u32, r.round() as u32);
    let revs = revs.clamp(1, 200);
    let steps = (revs as usize * 240).min(60_000);
    let k = (big - r) / r;
    let mut pl = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let t = TAU * revs as f32 * i as f32 / steps as f32;
        let x = (big - r) * t.cos() + d * (k * t).cos();
        let y = (big - r) * t.sin() - d * (k * t).sin();
        pl.push((x, y));
    }
    fit(vec![pl], p.width, p.height)
}

// ---- L-system -----------------------------------------------------------------------------------

/// (axiom, rules as (char, expansion), default turn angle°). 'F'/'G' draw, +/- turn, [ ] branch.
fn preset(name: &str) -> (&'static str, &'static [(char, &'static str)], f32) {
    match name {
        "dragon" => ("FX", &[('X', "X+YF+"), ('Y', "-FX-Y")], 90.0),
        "sierpinski" => ("F-G-G", &[('F', "F-G+F+G-F"), ('G', "GG")], 120.0),
        "plant" => ("X", &[('X', "F+[[X]-X]-F[-FX]+X"), ('F', "FF")], 25.0),
        "hilbert" => ("A", &[('A', "-BF+AFA+FB-"), ('B', "+AF-BFB-FA+")], 90.0),
        _ => ("F", &[('F', "F+F-F-F+F")], 90.0), // Koch
    }
}

fn lsystem(p: &Params) -> Vec<Stroke> {
    let (axiom, rules, def_angle) = preset(&p.preset);
    let angle = if p.angle > 0.0 { p.angle } else { def_angle }.to_radians();
    let mut s = axiom.to_string();
    for _ in 0..p.iterations.clamp(0, 10) {
        let mut next = String::with_capacity(s.len() * 3);
        for c in s.chars() {
            match rules.iter().find(|r| r.0 == c) {
                Some((_, exp)) => next.push_str(exp),
                None => next.push(c),
            }
        }
        s = next;
        if s.len() > 2_000_000 {
            break; // runaway guard
        }
    }
    // Turtle.
    let (mut x, mut y, mut a) = (0.0f32, 0.0f32, 0.0f32);
    let mut stack: Vec<(f32, f32, f32)> = Vec::new();
    let mut polys: Vec<Vec<(f32, f32)>> = Vec::new();
    let mut cur: Vec<(f32, f32)> = vec![(x, y)];
    for c in s.chars() {
        match c {
            'F' | 'G' => {
                x += a.cos();
                y += a.sin();
                cur.push((x, y));
            }
            '+' => a += angle,
            '-' => a -= angle,
            '[' => stack.push((x, y, a)),
            ']' => {
                if cur.len() >= 2 {
                    polys.push(std::mem::take(&mut cur));
                } else {
                    cur.clear();
                }
                if let Some((px, py, pa)) = stack.pop() {
                    x = px;
                    y = py;
                    a = pa;
                }
                cur.push((x, y));
            }
            _ => {}
        }
    }
    if cur.len() >= 2 {
        polys.push(cur);
    }
    fit(polys, p.width, p.height)
}

// ---- Truchet tiles ------------------------------------------------------------------------------

fn arc(cx: f32, cy: f32, r: f32, a0: f32, a1: f32, out: &mut Vec<(f32, f32)>) {
    let n = 10;
    for i in 0..=n {
        let t = a0 + (a1 - a0) * i as f32 / n as f32;
        out.push((cx + r * t.cos(), cy + r * t.sin()));
    }
}

fn truchet(p: &Params) -> Vec<Stroke> {
    let s = p.cell.max(2.0);
    let cols = (p.width / s).max(1.0) as usize;
    let rows = (p.height / s).max(1.0) as usize;
    let mut rng = Rng::new(p.seed);
    let mut out = Vec::new();
    for gy in 0..rows {
        for gx in 0..cols {
            let (ox, oy) = (gx as f32 * s, gy as f32 * s);
            let flip = rng.next() & 1 == 0;
            if p.style == "lines" {
                let seg = if flip { [(ox, oy), (ox + s, oy + s)] } else { [(ox + s, oy), (ox, oy + s)] };
                out.push(poly(vec![pt(seg[0].0, seg[0].1), pt(seg[1].0, seg[1].1)]));
            } else {
                // Two quarter arcs joining edge midpoints (the classic Smith/Truchet tiling).
                let r = s * 0.5;
                let mut a = Vec::new();
                let mut b = Vec::new();
                if flip {
                    arc(ox, oy, r, 0.0, std::f32::consts::FRAC_PI_2, &mut a);
                    arc(ox + s, oy + s, r, std::f32::consts::PI, std::f32::consts::PI + std::f32::consts::FRAC_PI_2, &mut b);
                } else {
                    arc(ox + s, oy, r, std::f32::consts::FRAC_PI_2, std::f32::consts::PI, &mut a);
                    arc(ox, oy + s, r, -std::f32::consts::FRAC_PI_2, 0.0, &mut b);
                }
                out.push(poly(a.into_iter().map(|(x, y)| pt(x, y)).collect()));
                out.push(poly(b.into_iter().map(|(x, y)| pt(x, y)).collect()));
            }
        }
    }
    out
}

// ---- Voronoi (via Delaunay) ---------------------------------------------------------------------

fn circumcenter(a: &delaunator::Point, b: &delaunator::Point, c: &delaunator::Point) -> (f32, f32) {
    let (ax, ay, bx, by, cx, cy) = (a.x, a.y, b.x, b.y, c.x, c.y);
    let d = 2.0 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if d.abs() < 1e-12 {
        return (((ax + bx + cx) / 3.0) as f32, ((ay + by + cy) / 3.0) as f32);
    }
    let a2 = ax * ax + ay * ay;
    let b2 = bx * bx + by * by;
    let c2 = cx * cx + cy * cy;
    let ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    let uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    (ux as f32, uy as f32)
}

fn voronoi(p: &Params) -> Vec<Stroke> {
    let n = p.points.clamp(3, 5000) as usize;
    let mut rng = Rng::new(p.seed);
    let pts: Vec<delaunator::Point> = (0..n)
        .map(|_| delaunator::Point { x: (rng.f32() * p.width) as f64, y: (rng.f32() * p.height) as f64 })
        .collect();
    let tri = delaunator::triangulate(&pts);
    if tri.triangles.is_empty() {
        return Vec::new();
    }
    let ntri = tri.triangles.len() / 3;
    let cc: Vec<(f32, f32)> = (0..ntri)
        .map(|t| circumcenter(&pts[tri.triangles[3 * t]], &pts[tri.triangles[3 * t + 1]], &pts[tri.triangles[3 * t + 2]]))
        .collect();
    // Clip each Voronoi edge to the box so the unbounded hull cells crop cleanly (no spikes).
    let mut out = Vec::new();
    for e in 0..tri.halfedges.len() {
        let o = tri.halfedges[e];
        if o != delaunator::EMPTY && e < o {
            let (x1, y1) = cc[e / 3];
            let (x2, y2) = cc[o / 3];
            if let Some(((cx1, cy1), (cx2, cy2))) = clip_box(x1, y1, x2, y2, p.width, p.height) {
                out.push(poly(vec![pt(cx1, cy1), pt(cx2, cy2)]));
            }
        }
    }
    out
}

/// Liang–Barsky clip of a segment to `[0,w]×[0,h]`; None if it misses the box entirely.
fn clip_box(x0: f32, y0: f32, x1: f32, y1: f32, w: f32, h: f32) -> Option<((f32, f32), (f32, f32))> {
    let (dx, dy) = (x1 - x0, y1 - y0);
    let p = [-dx, dx, -dy, dy];
    let q = [x0, w - x0, y0, h - y0];
    let (mut t0, mut t1) = (0.0f32, 1.0f32);
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
                if t > t0 {
                    t0 = t;
                }
            } else {
                if t < t0 {
                    return None;
                }
                if t < t1 {
                    t1 = t;
                }
            }
        }
    }
    Some(((x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy)))
}

// ---- noise flow field ---------------------------------------------------------------------------

fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846ca68b);
    x ^= x >> 16;
    x
}

/// Value noise on the integer lattice, smoothstep-interpolated, in -1..1.
fn vnoise(x: f32, y: f32, seed: u32) -> f32 {
    let (xi, yi) = (x.floor(), y.floor());
    let (xf, yf) = (x - xi, y - yi);
    let g = |ix: i32, iy: i32| -> f32 {
        let h = hash((ix as u32).wrapping_mul(374761393) ^ (iy as u32).wrapping_mul(668265263) ^ seed.wrapping_mul(2246822519));
        h as f32 / u32::MAX as f32 * 2.0 - 1.0
    };
    let (x0, y0) = (xi as i32, yi as i32);
    let u = xf * xf * (3.0 - 2.0 * xf);
    let v = yf * yf * (3.0 - 2.0 * yf);
    let a = g(x0, y0);
    let b = g(x0 + 1, y0);
    let c = g(x0, y0 + 1);
    let d = g(x0 + 1, y0 + 1);
    let ab = a + (b - a) * u;
    let cd = c + (d - c) * u;
    ab + (cd - ab) * v
}

fn flow(p: &Params) -> Vec<Stroke> {
    let n = p.lines.clamp(1, 4000) as usize;
    let steps = p.steps.clamp(2, 4000) as usize;
    let scale = p.noise_scale.clamp(0.001, 1.0);
    let step_len = (p.width.min(p.height) / steps as f32).max(0.3).min(1.5);
    let mut rng = Rng::new(p.seed);
    let mut out = Vec::new();
    for _ in 0..n {
        let (mut x, mut y) = (rng.f32() * p.width, rng.f32() * p.height);
        let mut pl = vec![(x, y)];
        for _ in 0..steps {
            let a = vnoise(x * scale, y * scale, p.seed) * TAU;
            x += step_len * a.cos();
            y += step_len * a.sin();
            if x < 0.0 || y < 0.0 || x > p.width || y > p.height {
                break;
            }
            pl.push((x, y));
        }
        if pl.len() >= 2 {
            out.push(poly(pl.into_iter().map(|(x, y)| pt(x, y)).collect()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(kind: &str) -> Vec<Stroke> {
        generate(&format!(r#"{{"kind":"{kind}","width":120,"height":120,"seed":3}}"#))
    }
    #[test]
    fn every_kind_produces_strokes() {
        for k in ["spirograph", "lsystem", "truchet", "voronoi", "flow"] {
            let out = run(k);
            assert!(!out.is_empty(), "{k} produced no strokes");
            for s in &out {
                assert!(s.points.len() >= 2);
            }
        }
    }
    #[test]
    fn deterministic_per_seed() {
        let a = generate(r#"{"kind":"voronoi","width":100,"height":100,"seed":7}"#);
        let b = generate(r#"{"kind":"voronoi","width":100,"height":100,"seed":7}"#);
        assert_eq!(a.len(), b.len());
    }
}
