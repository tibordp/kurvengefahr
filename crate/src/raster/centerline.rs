//! **Centerline tracing**: for line art, trace the *skeleton* of the inked region as single pen
//! strokes, instead of outlining both sides of every line (which `contours` does). Threshold →
//! Zhang–Suen thinning to a 1px skeleton → greedy chain into polylines → RDP simplify. Ideal for
//! hand drawings, signatures and technical line work, where you want one stroke down each line.

use super::{Grid, Params};
use crate::geom::{Point, Stroke};

/// Cap the working resolution so thinning stays fast; line art at ~1000 px is plenty.
const MAX_DIM: usize = 1000;

pub fn centerline(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let cutoff = 1.0 - p.threshold as f32 / 255.0;
    // Downsample to a binary mask (any inked source pixel in a block ⇒ inked, so thin lines survive).
    let f = (grid.w.max(grid.h) / MAX_DIM).max(1);
    let (mw, mh) = (grid.w / f, grid.h / f);
    if mw < 3 || mh < 3 {
        return Vec::new();
    }
    let mut mask = vec![0u8; mw * mh];
    for my in 0..mh {
        for mx in 0..mw {
            let mut inked = false;
            'blk: for dy in 0..f {
                for dx in 0..f {
                    let (ox, oy) = (mx * f + dx, my * f + dy);
                    if ox < grid.w && oy < grid.h && grid.at(ox, oy) >= cutoff {
                        inked = true;
                        break 'blk;
                    }
                }
            }
            mask[my * mw + mx] = inked as u8;
        }
    }

    thin(&mut mask, mw, mh);

    // mask pixel → element-local mm (block centre).
    let smx = grid.sx * f as f32;
    let smy = grid.sy * f as f32;
    let to_mm = |x: usize, y: usize| ((x as f32 + 0.5) * smx, (y as f32 + 0.5) * smy);
    let tol = if p.simplify_tol > 0.0 {
        p.simplify_tol
    } else {
        0.2
    };

    let mut out = Vec::new();
    for poly in trace(&mask, mw, mh) {
        if poly.len() < 2 {
            continue;
        }
        let flat: Vec<f32> = poly
            .iter()
            .flat_map(|&(x, y)| {
                let (mx, my) = to_mm(x, y);
                [mx, my]
            })
            .collect();
        let kept = crate::shapes::simplify(&flat, tol);
        let pts: Vec<Point> = kept
            .chunks_exact(2)
            .map(|c| Point {
                x: c[0],
                y: c[1],
                pressure: 1.0,
            })
            .collect();
        if pts.len() >= 2 {
            out.push(Stroke {
                points: pts,
                pen: 0,
                reversible: true,
                group: 0,
            });
        }
    }
    out
}

// ---- Zhang–Suen thinning ------------------------------------------------------------------------

/// The 8 neighbours of (x,y), clockwise from north: P2,P3,…,P9 (1 = inked).
#[inline]
fn p8(m: &[u8], w: usize, x: usize, y: usize) -> [u8; 8] {
    [
        m[(y - 1) * w + x],     // P2 N
        m[(y - 1) * w + x + 1], // P3 NE
        m[y * w + x + 1],       // P4 E
        m[(y + 1) * w + x + 1], // P5 SE
        m[(y + 1) * w + x],     // P6 S
        m[(y + 1) * w + x - 1], // P7 SW
        m[y * w + x - 1],       // P8 W
        m[(y - 1) * w + x - 1], // P9 NW
    ]
}

/// 0→1 transitions around P2..P9..P2.
#[inline]
fn transitions(p: &[u8; 8]) -> u8 {
    let mut t = 0;
    for i in 0..8 {
        if p[i] == 0 && p[(i + 1) % 8] == 1 {
            t += 1;
        }
    }
    t
}

fn thin(mask: &mut [u8], w: usize, h: usize) {
    let mut changed = true;
    let mut iters = 0;
    while changed && iters < 200 {
        changed = false;
        iters += 1;
        for step in 0..2 {
            let mut remove = Vec::new();
            for y in 1..h - 1 {
                for x in 1..w - 1 {
                    if mask[y * w + x] == 0 {
                        continue;
                    }
                    let p = p8(mask, w, x, y);
                    let b: u8 = p.iter().sum();
                    if !(2..=6).contains(&b) || transitions(&p) != 1 {
                        continue;
                    }
                    // step 0: P2·P4·P6=0 ∧ P4·P6·P8=0 ; step 1: P2·P4·P8=0 ∧ P2·P6·P8=0
                    let cond = if step == 0 {
                        p[0] * p[2] * p[4] == 0 && p[2] * p[4] * p[6] == 0
                    } else {
                        p[0] * p[2] * p[6] == 0 && p[0] * p[4] * p[6] == 0
                    };
                    if cond {
                        remove.push(y * w + x);
                    }
                }
            }
            if !remove.is_empty() {
                changed = true;
                for i in remove {
                    mask[i] = 0;
                }
            }
        }
    }
}

// ---- trace skeleton → polylines -----------------------------------------------------------------

const NB: [(isize, isize); 8] = [
    (0, -1),
    (1, -1),
    (1, 0),
    (1, 1),
    (0, 1),
    (-1, 1),
    (-1, 0),
    (-1, -1),
];

fn neighbors(m: &[u8], w: usize, h: usize, x: usize, y: usize) -> Vec<(usize, usize)> {
    let mut v = Vec::with_capacity(8);
    for &(dx, dy) in &NB {
        let (nx, ny) = (x as isize + dx, y as isize + dy);
        if nx >= 0
            && ny >= 0
            && (nx as usize) < w
            && (ny as usize) < h
            && m[ny as usize * w + nx as usize] == 1
        {
            v.push((nx as usize, ny as usize));
        }
    }
    v
}

/// Greedily chain skeleton pixels into polylines: start from endpoints (degree 1) first, then any
/// leftover loops, walking the straightest unvisited neighbour each step. Junctions split branches
/// into separate polylines (a sub-pixel gap that's well under a pen width once scaled to mm).
fn trace(mask: &[u8], w: usize, h: usize) -> Vec<Vec<(usize, usize)>> {
    let mut visited = vec![false; w * h];
    let mut out = Vec::new();
    let deg = |x: usize, y: usize| neighbors(mask, w, h, x, y).len();

    let walk = |sx: usize, sy: usize, visited: &mut [bool]| -> Vec<(usize, usize)> {
        let mut poly = vec![(sx, sy)];
        visited[sy * w + sx] = true;
        let (mut cx, mut cy) = (sx, sy);
        let (mut pdx, mut pdy) = (0.0f32, 0.0f32);
        loop {
            let cand: Vec<(usize, usize)> = neighbors(mask, w, h, cx, cy)
                .into_iter()
                .filter(|&(nx, ny)| !visited[ny * w + nx])
                .collect();
            if cand.is_empty() {
                break;
            }
            // Pick the straightest continuation (max dot with previous direction).
            let mut best = cand[0];
            let mut bests = f32::NEG_INFINITY;
            for &(nx, ny) in &cand {
                let (dx, dy) = (nx as f32 - cx as f32, ny as f32 - cy as f32);
                let l = (dx * dx + dy * dy).sqrt().max(1e-6);
                let s = if pdx == 0.0 && pdy == 0.0 {
                    0.0
                } else {
                    (dx / l) * pdx + (dy / l) * pdy
                };
                if s > bests {
                    bests = s;
                    best = (nx, ny);
                }
            }
            let (nx, ny) = best;
            let (dx, dy) = (nx as f32 - cx as f32, ny as f32 - cy as f32);
            let l = (dx * dx + dy * dy).sqrt().max(1e-6);
            pdx = dx / l;
            pdy = dy / l;
            visited[ny * w + nx] = true;
            poly.push((nx, ny));
            cx = nx;
            cy = ny;
        }
        poly
    };

    // Endpoints first, so chains run end-to-end rather than from the middle.
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            if mask[y * w + x] == 1 && !visited[y * w + x] && deg(x, y) == 1 {
                out.push(walk(x, y, &mut visited));
            }
        }
    }
    // Leftover loops with no endpoints.
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            if mask[y * w + x] == 1 && !visited[y * w + x] {
                out.push(walk(x, y, &mut visited));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_from(rows: &[&str]) -> Grid {
        let h = rows.len();
        let w = rows[0].len();
        let mut rgba = vec![255u8; w * h * 4];
        for (y, row) in rows.iter().enumerate() {
            for (x, c) in row.chars().enumerate() {
                if c == '#' {
                    let i = (y * w + x) * 4;
                    rgba[i] = 0;
                    rgba[i + 1] = 0;
                    rgba[i + 2] = 0;
                }
            }
        }
        Grid::build(&rgba, w, h, w as f32, h as f32, false)
    }

    #[test]
    fn traces_a_thick_line_as_one_stroke() {
        // A 3px-thick horizontal bar should thin to a single centreline polyline.
        let rows = [
            "............",
            "............",
            ".##########.",
            ".##########.",
            ".##########.",
            "............",
            "............",
        ];
        let g = grid_from(&rows);
        let p = Params {
            method: "centerline".into(),
            threshold: 128,
            ..Default::default()
        };
        let out = centerline(&g, &p);
        assert_eq!(
            out.len(),
            1,
            "one centreline for the bar, got {}",
            out.len()
        );
        // It thins to a single horizontal line near the bar's vertical centre, spanning most of it.
        let s = &out[0];
        let xspan = s
            .points
            .iter()
            .fold((f32::MAX, f32::MIN), |(a, b), p| (a.min(p.x), b.max(p.x)));
        assert!(xspan.1 - xspan.0 > 5.0, "centreline spans the bar");
    }
}
