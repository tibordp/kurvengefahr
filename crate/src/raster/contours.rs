//! **Outline tracing** (`contours`): threshold the inkness grid → trace the ink/paper boundary as
//! closed rectilinear loops → elastic-smooth + RDP-simplify. The faithful, line-art rendering.

use std::collections::HashMap;

use super::{Grid, Params};
use crate::geom::{Point, Stroke};
use crate::shapes::simplify;

/// Lattice vertex (pixel-corner) coordinate. The corner grid is `(w+1) × (h+1)`.
type V = (i32, i32);

/// Trace closed ink/paper boundary loops. `threshold` 0..255 sets the ink cutoff on inkness (higher
/// = more ink); `simplify_tol` (mm) drives both smoothing and decimation; `min_area` despeckles
/// loops under that many px².
pub fn contours(grid: &Grid, p: &Params) -> Vec<Stroke> {
    // Binarize: ink where inkness clears the cutoff (threshold 0..255, higher = more ink). The grid
    // already folded in luma/composite/invert.
    let cutoff = 1.0 - p.threshold as f32 / 255.0;
    let ink: Vec<bool> = (0..grid.w * grid.h)
        .map(|i| grid.ink_at(i) >= cutoff)
        .collect();
    let sx = grid.tw / grid.w as f32;
    let sy = grid.th / grid.h as f32;
    trace_mask(&ink, grid.w, grid.h, sx, sy, p.simplify_tol, p.min_area)
}

/// Trace a binary mask's region boundaries as closed vector loops: directed-edge walk (outer rings +
/// holes, interior on the right) → elastic smoothing → RDP decimation. Lattice corner `(x, y)` maps
/// to mm `(x·sx, y·sy)`; `simplify_tol` (mm) drives smoothing + decimation; `min_area` despeckles
/// loops under that many cells². Shared by outline tracing (ink mask) and flood fill (region mask).
pub(crate) fn trace_mask(
    mask: &[bool],
    w: usize,
    h: usize,
    sx: f32,
    sy: f32,
    simplify_tol: f32,
    min_area: f32,
) -> Vec<Stroke> {
    let is_ink = |x: i32, y: i32| -> bool {
        x >= 0
            && y >= 0
            && (x as usize) < w
            && (y as usize) < h
            && mask[y as usize * w + x as usize]
    };

    // Build the directed boundary: each ink cell contributes the clockwise edges of its unit square
    // (TL→TR→BR→BL→TL) whose neighbour across that edge is *not* ink. Shared edges between two ink
    // cells are traversed in opposite directions and cancel, leaving the region boundary with the
    // interior consistently on the right.
    let mut edges: Vec<(V, V)> = Vec::new();
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            if !is_ink(x, y) {
                continue;
            }
            let tl = (x, y);
            let tr = (x + 1, y);
            let br = (x + 1, y + 1);
            let bl = (x, y + 1);
            if !is_ink(x, y - 1) {
                edges.push((tl, tr)); // top
            }
            if !is_ink(x + 1, y) {
                edges.push((tr, br)); // right
            }
            if !is_ink(x, y + 1) {
                edges.push((br, bl)); // bottom
            }
            if !is_ink(x - 1, y) {
                edges.push((bl, tl)); // left
            }
        }
    }
    if edges.is_empty() {
        return vec![];
    }

    // Index edges by their start vertex so a walk can find the next segment.
    let mut starts: HashMap<V, Vec<usize>> = HashMap::new();
    for (i, e) in edges.iter().enumerate() {
        starts.entry(e.0).or_default().push(i);
    }
    let mut used = vec![false; edges.len()];

    // Walk closed loops, consuming edges. Each walk follows outgoing edges until it returns to its
    // start vertex; pinch points (a vertex shared by two loops) just resolve to *some* valid set of
    // closed loops, which is all we need — every boundary edge is drawn exactly once.
    let mut out: Vec<Stroke> = Vec::new();
    for i in 0..edges.len() {
        if used[i] {
            continue;
        }
        let s = edges[i].0;
        let mut cur = s;
        let mut loop_v: Vec<V> = vec![s];
        loop {
            let next_edge = starts
                .get(&cur)
                .and_then(|list| list.iter().copied().find(|&ei| !used[ei]));
            let ei = match next_edge {
                Some(ei) => ei,
                None => break, // dead end (shouldn't happen on a closed boundary)
            };
            used[ei] = true;
            cur = edges[ei].1;
            loop_v.push(cur);
            if cur == s {
                break;
            }
        }
        if loop_v.len() < 4 {
            continue;
        }
        // Despeckle by absolute polygon area (px²); holes have opposite orientation, so use |area|.
        if polygon_area(&loop_v) < min_area {
            continue;
        }
        // Scale the rectilinear loop to mm, then smooth + decimate it (`simplify_tol` controls both).
        let scaled: Vec<(f32, f32)> = loop_v
            .iter()
            .map(|v| (v.0 as f32 * sx, v.1 as f32 * sy))
            .collect();
        // Elastic-band smoothing: contract the staircase taut, leashed to within `simplify_tol` of
        // the true edge, so quantization noise melts into smooth curves without drifting off-shape.
        let smoothed = elastic_smooth(&scaled, simplify_tol);
        // Drop now-redundant points (a fraction of the budget, so it thins without re-faceting).
        let flat: Vec<f32> = smoothed.iter().flat_map(|p| [p.0, p.1]).collect();
        let decimated = simplify(&flat, simplify_tol * DECIMATE_FRAC);
        let n = decimated.len() / 2;
        if n < 4 {
            continue;
        }
        let points: Vec<Point> = (0..n)
            .map(|k| Point {
                x: decimated[2 * k],
                y: decimated[2 * k + 1],
                pressure: 1.0,
            })
            .collect();
        out.push(Stroke {
            points,
            pen: 0,
            reversible: true,
            group: 0,
        });
    }
    out
}

// --- elastic-band smoothing -----------------------------------------------------------------------
// A contour is treated like an elastic band: an internal contraction force (curve-shortening) pulls
// each vertex toward the midpoint of its neighbours, while a leash keeps it within `tol` of the
// pixel-true edge so the shape can't drift. Genuine sharp corners are pinned so they stay crisp;
// only quantization staircase noise smooths away.

const ELASTIC_ITERS: usize = 24;
const ELASTIC_RELAX: f32 = 0.5;
/// Decimation tolerance as a fraction of the smoothing leash — small, so it thins the smoothed loop
/// without re-introducing facets.
const DECIMATE_FRAC: f32 = 0.25;
/// Window (vertices) over which a corner's turn is measured — wide enough to ignore single-pixel
/// stair steps, narrow enough to localize a real corner.
const CORNER_WINDOW: usize = 3;
/// cos of the turn angle past which a vertex is pinned as a true corner (here ≈ 60°).
const CORNER_COS: f32 = 0.5;

/// Smooth a closed loop (`pts[0] == pts[last]`) with a tolerance-leashed curve-shortening flow,
/// pinning sharp corners. Returns a closed loop (re-closed). `tol <= 0` or tiny loops pass through.
fn elastic_smooth(pts: &[(f32, f32)], tol: f32) -> Vec<(f32, f32)> {
    let m = pts.len().saturating_sub(1); // distinct vertices (last duplicates first)
    if m < 4 || tol <= 0.0 {
        return pts.to_vec();
    }
    let orig = &pts[..m];
    let pinned = detect_corners(orig);
    let tol2 = tol * tol;
    let mut cur: Vec<(f32, f32)> = orig.to_vec();
    for _ in 0..ELASTIC_ITERS {
        let prev = cur.clone(); // Jacobi update: read the whole previous state, write the next
        for i in 0..m {
            if pinned[i] {
                continue; // a real corner stays put
            }
            let a = prev[(i + m - 1) % m];
            let b = prev[(i + 1) % m];
            let mid = ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5);
            let mut np = (
                prev[i].0 + (mid.0 - prev[i].0) * ELASTIC_RELAX,
                prev[i].1 + (mid.1 - prev[i].1) * ELASTIC_RELAX,
            );
            // Leash: never let a vertex stray more than `tol` from where the trace put it.
            let dx = np.0 - orig[i].0;
            let dy = np.1 - orig[i].1;
            let d2 = dx * dx + dy * dy;
            if d2 > tol2 {
                let d = d2.sqrt();
                np = (orig[i].0 + dx / d * tol, orig[i].1 + dy / d * tol);
            }
            cur[i] = np;
        }
    }
    cur.push(cur[0]); // re-close
    cur
}

/// Flag vertices whose turn (measured over a small window, so single-pixel stairs read as straight)
/// is sharper than `CORNER_COS` — genuine corners to preserve rather than round away.
fn detect_corners(pts: &[(f32, f32)]) -> Vec<bool> {
    let m = pts.len();
    let mut pinned = vec![false; m];
    if m < 2 * CORNER_WINDOW + 1 {
        return pinned;
    }
    for i in 0..m {
        let a = pts[(i + m - CORNER_WINDOW) % m];
        let p = pts[i];
        let c = pts[(i + CORNER_WINDOW) % m];
        let v1 = (p.0 - a.0, p.1 - a.1);
        let v2 = (c.0 - p.0, c.1 - p.1);
        let n1 = (v1.0 * v1.0 + v1.1 * v1.1).sqrt();
        let n2 = (v2.0 * v2.0 + v2.1 * v2.1).sqrt();
        if n1 < 1e-6 || n2 < 1e-6 {
            continue;
        }
        let cos = (v1.0 * v2.0 + v1.1 * v2.1) / (n1 * n2);
        if cos < CORNER_COS {
            pinned[i] = true;
        }
    }
    pinned
}

/// Shoelace area (absolute) of a closed lattice loop, in px².
fn polygon_area(loop_v: &[V]) -> f32 {
    let mut a: i64 = 0;
    for i in 0..loop_v.len() - 1 {
        let (x0, y0) = loop_v[i];
        let (x1, y1) = loop_v[i + 1];
        a += x0 as i64 * y1 as i64 - x1 as i64 * y0 as i64;
    }
    (a.abs() as f32) * 0.5
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an RGBA buffer from an ASCII mask (`#` = black ink, ` ` = white).
    fn mask(rows: &[&str]) -> (Vec<u8>, u32, u32) {
        let h = rows.len();
        let w = rows[0].len();
        let mut rgba = vec![255u8; w * h * 4];
        for (y, row) in rows.iter().enumerate() {
            for (x, c) in row.chars().enumerate() {
                if c == '#' {
                    let p = (y * w + x) * 4;
                    rgba[p] = 0;
                    rgba[p + 1] = 0;
                    rgba[p + 2] = 0;
                }
            }
        }
        (rgba, w as u32, h as u32)
    }

    /// Run `contours` on a mask with the given smoothing/despeckle/invert (threshold fixed at 128).
    fn run(rows: &[&str], simplify_tol: f32, min_area: f32, invert: bool) -> Vec<Stroke> {
        let (rgba, w, h) = mask(rows);
        let grid = Grid::build(&rgba, w as usize, h as usize, w as f32, h as f32, invert);
        let p = Params {
            simplify_tol,
            min_area,
            threshold: 128,
            ..Default::default()
        };
        contours(&grid, &p)
    }

    fn trace(rows: &[&str]) -> Vec<Stroke> {
        run(rows, 0.0, 1.0, false)
    }

    /// Sum of absolute turn angles along a (closed) stroke — a measure of jaggedness.
    fn total_abs_turn(s: &Stroke) -> f32 {
        use std::f32::consts::PI;
        let p = &s.points;
        let mut t = 0.0;
        for i in 1..p.len().saturating_sub(1) {
            let v1 = (p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
            let v2 = (p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
            let mut d = (v2.1.atan2(v2.0) - v1.1.atan2(v1.0)).abs();
            if d > PI {
                d = 2.0 * PI - d;
            }
            t += d;
        }
        t
    }

    #[test]
    fn solid_block_is_one_contour() {
        let out = trace(&[
            "        ", " ####   ", " ####   ", " ####   ", " ####   ", "        ",
        ]);
        assert_eq!(out.len(), 1);
        // Closed loop: first point repeated at the end.
        let p = &out[0].points;
        assert!(p.len() >= 5);
        assert_eq!((p[0].x, p[0].y), (p[p.len() - 1].x, p[p.len() - 1].y));
    }

    #[test]
    fn frame_has_outer_and_hole() {
        // A ring of ink → outer boundary + the inner hole boundary = 2 contours.
        let out = trace(&["#####", "#   #", "#   #", "#   #", "#####"]);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn separate_blocks_each_get_a_contour() {
        // Four disjoint 2×2 blocks → four independent contours.
        let out = trace(&["##  ##", "##  ##", "      ", "##  ##", "##  ##"]);
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn min_area_despeckles() {
        // The lone 1px speck (area 1) is dropped at min_area=2; the 2×2 block (area 4) survives.
        let out = run(&["#    ", "   ##", "   ##", "     "], 0.0, 2.0, false);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn smoothing_reduces_jaggedness() {
        // A big staircase hypotenuse: with a smoothing budget it should straighten out, so the
        // smoothed contour turns far less in total than the raw rectilinear one. tol=0 is faithful.
        let tri = &[
            "########", "####### ", "######  ", "#####   ", "####    ", "###     ", "##      ",
            "#       ",
        ];
        let raw = run(tri, 0.0, 1.0, false);
        let smooth = run(tri, 1.5, 1.0, false);
        assert_eq!(raw.len(), 1);
        assert_eq!(smooth.len(), 1);
        // Still a closed loop.
        let p = &smooth[0].points;
        assert_eq!((p[0].x, p[0].y), (p[p.len() - 1].x, p[p.len() - 1].y));
        assert!(
            total_abs_turn(&smooth[0]) < total_abs_turn(&raw[0]) * 0.8,
            "smoothing should noticeably reduce total turning (raw {}, smooth {})",
            total_abs_turn(&raw[0]),
            total_abs_turn(&smooth[0]),
        );
    }

    #[test]
    fn smoothing_stays_within_tolerance() {
        // A solid block: smoothing must not push the outline more than ~tol beyond the true edges.
        let tol = 1.0;
        let out = run(
            &[
                "          ",
                " ######## ",
                " ######## ",
                " ######## ",
                " ######## ",
                " ######## ",
                " ######## ",
                " ######## ",
                " ######## ",
                "          ",
            ],
            tol,
            1.0,
            false,
        );
        assert_eq!(out.len(), 1);
        // The ink spans x,y ∈ [1,9]; with the leash every vertex stays within tol of that box.
        for p in &out[0].points {
            assert!(
                p.x >= 1.0 - tol - 1e-3 && p.x <= 9.0 + tol + 1e-3,
                "x {} out of leash",
                p.x
            );
            assert!(
                p.y >= 1.0 - tol - 1e-3 && p.y <= 9.0 + tol + 1e-3,
                "y {} out of leash",
                p.y
            );
        }
    }

    #[test]
    fn invert_traces_paper() {
        // All ink except a hole → with invert, the single white pixel becomes the only contour.
        let out = trace(&["###", "# #", "###"]);
        let inv = run(&["###", "# #", "###"], 0.0, 0.5, true);
        // Non-inverted: outer + hole = 2. Inverted: the paper pixel is the only ink → 1 loop.
        assert_eq!(out.len(), 2);
        assert_eq!(inv.len(), 1);
    }
}
