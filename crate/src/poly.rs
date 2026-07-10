//! Shared polygon utilities: even-odd point-in-polygon, segment↔ring crossings, and ring parsing.
//! Used by hatch fills, the DXF importer, and clip-to-shape. Pure scalar f32.

use crate::geom::Point;

pub type P = (f32, f32);

pub fn pt(x: f32, y: f32) -> Point {
    Point {
        x,
        y,
        pressure: 1.0,
    }
}

/// Flat `[x0,y0,…]` → one ring's vertices, dropping a trailing point that duplicates the first.
pub fn parse_poly(xy: &[f32]) -> Vec<P> {
    let mut v: Vec<P> = (0..xy.len() / 2)
        .map(|i| (xy[2 * i], xy[2 * i + 1]))
        .collect();
    if v.len() >= 2 {
        let f = v[0];
        let l = *v.last().unwrap();
        if (f.0 - l.0).abs() < 1e-6 && (f.1 - l.1).abs() < 1e-6 {
            v.pop();
        }
    }
    v
}

/// Split a multi-ring `xy` into rings via `ring_starts` (point units, `nrings+1` entries).
pub fn parse_polys(xy: &[f32], ring_starts: &[u32]) -> Vec<Vec<P>> {
    let nrings = ring_starts.len().saturating_sub(1);
    (0..nrings)
        .map(|r| parse_poly(&xy[ring_starts[r] as usize * 2..ring_starts[r + 1] as usize * 2]))
        .collect()
}

/// Even-odd ray-cast point-in-polygon for a single ring.
pub fn inside(poly: &[P], x: f32, y: f32) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut c = false;
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

/// Even-odd across all rings (XOR of per-ring parities): a point inside the outer ring and inside a
/// nested ring (hole) is *outside* the filled region. Orientation-independent.
pub fn inside_multi(rings: &[Vec<P>], x: f32, y: f32) -> bool {
    let mut c = false;
    for ring in rings {
        if inside(ring, x, y) {
            c = !c;
        }
    }
    c
}

/// Sorted, de-duplicated parameters t ∈ (0,1) where segment a→b crosses any ring's edges.
pub fn crossings(rings: &[Vec<P>], a: P, b: P) -> Vec<f32> {
    let (rx, ry) = (b.0 - a.0, b.1 - a.1);
    let mut ts: Vec<f32> = Vec::new();
    for poly in rings {
        let n = poly.len();
        if n < 3 {
            continue;
        }
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
                if t > 1e-6 && t < 1.0 - 1e-6 && (-1e-6..=1.0 + 1e-6).contains(&u) {
                    ts.push(t);
                }
            }
            j = i;
        }
    }
    ts.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    ts.dedup_by(|x, y| (*x - *y).abs() < 1e-5);
    ts
}
