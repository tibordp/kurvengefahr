//! Flood fill ("paint bucket"): rasterize the document's visible strokes — at the on-screen pen
//! width — into an occupancy grid over the page, BFS-fill the empty region around the seed, and
//! trace the region back to closed vector rings via the shared mask tracer. The page rectangle
//! bounds the fill, so a click in an unenclosed area fills up to the page edge rather than leaking
//! to infinity. Rings come back as outer boundaries + holes, ready to become a path element's
//! even-odd contours. Empty result = the seed landed on ink (or off the page).

use crate::geom::Stroke;
use crate::raster::trace_mask;

/// Cap on grid cells so a degenerate `res` can't allocate unbounded memory; the resolution is
/// coarsened to fit instead of failing.
const MAX_CELLS: usize = 8_000_000;

/// Flood fill from `(seed_x, seed_y)` on the page `[0,0]..[page_w,page_h]` (mm). `xy`/`offsets` are
/// the boundary strokes (flat points + CSR stroke offsets, point units), each `stroke_width` mm
/// thick; `res` is the requested grid cell size (mm).
// Mirrors the flat wasm boundary (positional by design); `!(x > 0.0)` deliberately rejects NaN
// along with non-positive values, which `x <= 0.0` would let through.
#[allow(clippy::too_many_arguments, clippy::neg_cmp_op_on_partial_ord)]
pub fn flood(
    xy: &[f32],
    offsets: &[u32],
    seed_x: f32,
    seed_y: f32,
    stroke_width: f32,
    page_w: f32,
    page_h: f32,
    res: f32,
) -> Vec<Stroke> {
    if !(page_w > 0.0) || !(page_h > 0.0) || !(res > 0.0) {
        return vec![];
    }
    let mut res = res;
    let cells = ((page_w / res).ceil() * (page_h / res).ceil()).max(1.0);
    if cells > MAX_CELLS as f32 {
        res *= (cells / MAX_CELLS as f32).sqrt();
    }
    let w = (page_w / res).ceil().max(1.0) as usize;
    let h = (page_h / res).ceil().max(1.0) as usize;

    let seed_cx = (seed_x / res).floor();
    let seed_cy = (seed_y / res).floor();
    if seed_cx < 0.0 || seed_cy < 0.0 || seed_cx >= w as f32 || seed_cy >= h as f32 {
        return vec![];
    }
    let seed = seed_cy as usize * w + seed_cx as usize;

    // Rasterize each stroke segment as a capsule of ink. The half-width floor (≈ 0.71·res, the
    // farthest a cell centre can sit from a line crossing its cell) guarantees even a hairline
    // marks a 4-connected barrier the fill can't slip through diagonally.
    let mut ink = vec![false; w * h];
    let half = (stroke_width * 0.5).max(res * 0.71);
    for s in 0..offsets.len().saturating_sub(1) {
        let a = offsets[s] as usize;
        let b = offsets[s + 1] as usize;
        if b <= a {
            continue;
        }
        if b - a == 1 {
            let p = (xy[2 * a], xy[2 * a + 1]);
            mark_capsule(&mut ink, w, h, res, p, p, half); // a dot
            continue;
        }
        for i in a..b - 1 {
            let p = (xy[2 * i], xy[2 * i + 1]);
            let q = (xy[2 * i + 2], xy[2 * i + 3]);
            mark_capsule(&mut ink, w, h, res, p, q, half);
        }
    }
    if ink[seed] {
        return vec![]; // clicked on a stroke — nothing to fill
    }

    // BFS over empty cells, 4-connected; the grid border (= page edge) is a wall.
    let mut filled = vec![false; w * h];
    filled[seed] = true;
    let mut queue = std::collections::VecDeque::from([seed]);
    while let Some(i) = queue.pop_front() {
        let (x, y) = (i % w, i / w);
        let mut push = |j: usize| {
            if !filled[j] && !ink[j] {
                filled[j] = true;
                queue.push_back(j);
            }
        };
        if x > 0 {
            push(i - 1);
        }
        if x + 1 < w {
            push(i + 1);
        }
        if y > 0 {
            push(i - w);
        }
        if y + 1 < h {
            push(i + w);
        }
    }

    // Trace the region boundary back to smooth closed loops (mm). The smoothing leash melts the
    // cell staircase without drifting more than ~a cell off the true edge; the despeckle floor
    // drops sub-pen-width slivers (grid-quantization artifacts along nearly-tangent strokes).
    let tol = res * 1.2;
    let min_area_cells = (0.1 / (res * res)).max(1.0); // 0.1 mm²
    trace_mask(&filled, w, h, res, res, tol, min_area_cells)
}

/// Mark every cell whose centre lies within `half` of segment `a`→`b` (a capsule; `a == b` = disc).
fn mark_capsule(
    ink: &mut [bool],
    w: usize,
    h: usize,
    res: f32,
    a: (f32, f32),
    b: (f32, f32),
    half: f32,
) {
    let x0 = (((a.0.min(b.0) - half) / res).floor().max(0.0)) as usize;
    let y0 = (((a.1.min(b.1) - half) / res).floor().max(0.0)) as usize;
    let x1 = (((a.0.max(b.0) + half) / res).ceil()).min(w as f32 - 1.0);
    let y1 = (((a.1.max(b.1) + half) / res).ceil()).min(h as f32 - 1.0);
    if x1 < 0.0 || y1 < 0.0 {
        return;
    }
    let (x1, y1) = (x1 as usize, y1 as usize);
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let half2 = half * half;
    for cy in y0..=y1 {
        let py = (cy as f32 + 0.5) * res;
        for cx in x0..=x1 {
            let px = (cx as f32 + 0.5) * res;
            // Distance² from the cell centre to the closest point on the segment.
            let t = if len2 > 0.0 {
                (((px - a.0) * dx + (py - a.1) * dy) / len2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let ex = px - (a.0 + t * dx);
            let ey = py - (a.1 + t * dy);
            if ex * ex + ey * ey <= half2 {
                ink[cy * w + cx] = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Point;

    /// Flatten polylines into the (xy, offsets) boundary form.
    fn flat(strokes: &[Vec<(f32, f32)>]) -> (Vec<f32>, Vec<u32>) {
        let mut xy = Vec::new();
        let mut offsets = vec![0u32];
        for s in strokes {
            for &(x, y) in s {
                xy.push(x);
                xy.push(y);
            }
            offsets.push(xy.len() as u32 / 2);
        }
        (xy, offsets)
    }

    fn bbox(pts: &[Point]) -> (f32, f32, f32, f32) {
        let mut b = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for p in pts {
            b = (b.0.min(p.x), b.1.min(p.y), b.2.max(p.x), b.3.max(p.y));
        }
        b
    }

    /// A closed 20×20 square outline of four strokes, at (10,10)..(30,30), on a 50×50 page.
    fn square() -> (Vec<f32>, Vec<u32>) {
        flat(&[
            vec![(10.0, 10.0), (30.0, 10.0)],
            vec![(30.0, 10.0), (30.0, 30.0)],
            vec![(30.0, 30.0), (10.0, 30.0)],
            vec![(10.0, 30.0), (10.0, 10.0)],
        ])
    }

    #[test]
    fn fills_inside_a_closed_square() {
        let (xy, off) = square();
        let out = flood(&xy, &off, 20.0, 20.0, 0.4, 50.0, 50.0, 0.1);
        assert_eq!(out.len(), 1);
        let p = &out[0].points;
        assert_eq!(
            (p[0].x, p[0].y),
            (p[p.len() - 1].x, p[p.len() - 1].y),
            "ring is closed"
        );
        // The fill abuts the ink from inside: roughly the square inset by the half stroke width.
        let (x0, y0, x1, y1) = bbox(p);
        for (got, want) in [(x0, 10.2), (y0, 10.2), (x1, 29.8), (y1, 29.8)] {
            assert!((got - want).abs() < 0.5, "edge {got} should be near {want}");
        }
    }

    #[test]
    fn seed_on_a_stroke_fills_nothing() {
        let (xy, off) = square();
        let out = flood(&xy, &off, 10.0, 20.0, 0.4, 50.0, 50.0, 0.1);
        assert!(out.is_empty());
    }

    #[test]
    fn island_inside_becomes_a_hole() {
        // The square plus a small closed diamond floating inside it.
        let (xy, off) = flat(&[
            vec![
                (10.0, 10.0),
                (30.0, 10.0),
                (30.0, 30.0),
                (10.0, 30.0),
                (10.0, 10.0),
            ],
            vec![
                (20.0, 17.0),
                (23.0, 20.0),
                (20.0, 23.0),
                (17.0, 20.0),
                (20.0, 17.0),
            ],
        ]);
        let out = flood(&xy, &off, 12.0, 12.0, 0.4, 50.0, 50.0, 0.1);
        assert_eq!(out.len(), 2, "outer ring + the island's hole ring");
    }

    #[test]
    fn unenclosed_seed_fills_to_the_page_edge() {
        let (xy, off) = square();
        let out = flood(&xy, &off, 2.0, 2.0, 0.4, 50.0, 50.0, 0.1);
        // Outside the square: the page-edge-bounded region, with the square as a hole.
        assert_eq!(out.len(), 2);
        let (x0, y0, x1, y1) = bbox(&out[0].points);
        assert!(
            x0 < 0.3 && y0 < 0.3 && x1 > 49.7 && y1 > 49.7,
            "outer ring hugs the page"
        );
    }

    #[test]
    fn leaks_through_a_real_gap_but_not_past_a_hairline() {
        // Same square but the top edge stops 5 mm short — the fill must escape through the gap.
        let (xy, off) = flat(&[
            vec![(10.0, 10.0), (25.0, 10.0)],
            vec![(30.0, 10.0), (30.0, 30.0)],
            vec![(30.0, 30.0), (10.0, 30.0)],
            vec![(10.0, 30.0), (10.0, 10.0)],
        ]);
        let out = flood(&xy, &off, 20.0, 20.0, 0.4, 50.0, 50.0, 0.1);
        let (x0, y0, x1, y1) = bbox(&out[0].points);
        assert!(
            x0 < 0.3 && y0 < 0.3 && x1 > 49.7 && y1 > 49.7,
            "fill escapes through the gap"
        );

        // A zero-width boundary must still block: the rasterizer's half-width floor keeps even a
        // hairline 4-connected.
        let (xy, off) = square();
        let out = flood(&xy, &off, 20.0, 20.0, 0.0, 50.0, 50.0, 0.1);
        assert_eq!(out.len(), 1);
        let (x0, _, x1, _) = bbox(&out[0].points);
        assert!(
            x0 > 9.5 && x1 < 30.5,
            "hairline square still contains the fill"
        );
    }

    #[test]
    fn off_page_seed_or_empty_page() {
        let (xy, off) = square();
        assert!(flood(&xy, &off, -5.0, 20.0, 0.4, 50.0, 50.0, 0.1).is_empty());
        // No strokes at all: the whole page becomes one ring.
        let out = flood(&[], &[0], 20.0, 20.0, 0.4, 50.0, 50.0, 0.1);
        assert_eq!(out.len(), 1);
    }
}
