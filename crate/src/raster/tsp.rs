//! **TSP art** (`tsp`). A density-weighted point cloud is sampled from the image (rejection sampling
//! on inkness — points land where it's dark), then *one continuous line* is threaded through all of
//! them: a grid nearest-neighbour seed, neighbour-list 2-opt, and a geometric uncrossing pass, so the
//! whole image becomes a single unbroken, non-self-intersecting squiggle. Seeded and randomized.

use std::collections::VecDeque;

use super::{pt, Grid, Params, Rng};
use crate::geom::{Point, Stroke};

/// TSP point budget, mapped *directly* off `detail` (not area-weighted) so the slider spans the whole
/// range. The solver is near-linear (grid NN + neighbour-list 2-opt), so this can be large enough to
/// reproduce an image faithfully — it's the point density that carries the likeness.
const MAX_TSP: usize = 50000;

/// Rejection-sample `target` points weighted by inkness (accept ∝ darkness). Returns mm coords.
pub(super) fn sample(grid: &Grid, seed: u32, target: usize) -> Vec<(f32, f32)> {
    if target == 0 {
        return vec![];
    }
    let mut rng = Rng::new(seed);
    let mut pts = Vec::with_capacity(target);
    // Cap attempts so a near-white image can't spin forever chasing an unreachable target.
    let mut attempts = 0usize;
    let budget = target.saturating_mul(40).max(10_000);
    while pts.len() < target && attempts < budget {
        attempts += 1;
        let x = rng.f32() * grid.tw;
        let y = rng.f32() * grid.th;
        if rng.f32() < grid.ink_mm(x, y) {
            pts.push((x, y));
        }
    }
    pts
}

pub fn tsp(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let target = (p.detail.clamp(0.0, 1.0) * MAX_TSP as f32) as usize;
    let pts = sample(grid, p.seed, target.max(2));
    if pts.len() < 2 {
        return vec![];
    }
    let order = solve(&pts);
    // One unbroken designed path — fixed direction so the artistic continuity survives optimization.
    let points: Vec<Point> = order.iter().map(|&i| pt(pts[i].0, pts[i].1)).collect();
    vec![Stroke { points, pen: 0, reversible: false, group: 0 }]
}

/// Number of nearest neighbours each city considers in 2-opt — small candidate lists are what make
/// the optimization near-linear instead of O(n²).
const KNN_K: usize = 8;

/// Build a good visiting order over `pts`. Strategy: a **grid-accelerated greedy nearest-neighbour**
/// seed, **neighbour-list 2-opt with don't-look bits**, then a **geometric uncrossing pass** that
/// removes the long-range self-intersections 2-opt's local candidate lists miss. Every stage avoids
/// the all-pairs O(n²) scan (a uniform spatial grid answers nearest / which-edges-share-a-cell), so
/// this stays usable at tens of thousands of points. The tour is optimized as a *cycle* (lets us
/// reverse the shorter arc of any move) and cut at its longest edge to yield an open, planar path.
fn solve(pts: &[(f32, f32)]) -> Vec<usize> {
    let n = pts.len();
    if n <= 3 {
        return (0..n).collect();
    }
    let dist = |a: usize, b: usize| {
        let dx = pts[a].0 - pts[b].0;
        let dy = pts[a].1 - pts[b].1;
        (dx * dx + dy * dy).sqrt()
    };

    let grid = SpatialGrid::build(pts);
    let mut order = grid.greedy_tour(pts);
    let nbrs = grid.knn(pts, KNN_K);
    two_opt(&mut order, &nbrs, &dist);
    // 2-opt over near-neighbour candidates leaves long-range crossings (their endpoints aren't in
    // each other's neighbour lists). A converged tour has none, so finish with a geometric pass that
    // finds actually-intersecting edge pairs and uncrosses them — self-intersections read as jarring.
    grid.uncross(pts, &mut order);

    // Cut the cycle at its longest edge so the open path doesn't include one ugly long jump.
    let mut cut = 0;
    let mut worst = -1.0f32;
    for p in 0..n {
        let d = dist(order[p], order[(p + 1) % n]);
        if d > worst {
            worst = d;
            cut = p;
        }
    }
    let start = (cut + 1) % n;
    (0..n).map(|t| order[(start + t) % n]).collect()
}

/// Neighbour-list 2-opt on a cyclic tour. For each city we only try reconnecting it to one of its
/// `KNN_K` nearest neighbours (sorted, so we stop as soon as a candidate is farther than the edge we'd
/// replace). Don't-look bits + a work queue mean we revisit only cities near a recent change, and a
/// reversal always flips the *shorter* arc — together that's roughly O(n) improving moves.
fn two_opt(order: &mut [usize], nbrs: &[u32], dist: &impl Fn(usize, usize) -> f32) {
    let n = order.len();
    let mut pos = vec![0u32; n];
    for (p, &c) in order.iter().enumerate() {
        pos[c] = p as u32;
    }
    let mut active = vec![true; n];
    let mut queue: VecDeque<usize> = (0..n).collect();
    // Bound total reversal work so a pathological input still terminates promptly.
    let mut budget: u64 = 60 * n as u64;

    while let Some(c1) = queue.pop_front() {
        if !active[c1] {
            continue;
        }
        active[c1] = false;
        let i = pos[c1] as usize;
        let s = order[(i + 1) % n]; // successor — the edge (c1, s) is the one we try to replace
        let d_c1_s = dist(c1, s);
        let mut moved = false;
        for t in 0..KNN_K {
            let c2 = nbrs[c1 * KNN_K + t];
            if c2 == u32::MAX {
                break;
            }
            let c2 = c2 as usize;
            let d_c1_c2 = dist(c1, c2);
            if d_c1_c2 >= d_c1_s {
                break; // neighbours are sorted; no closer reconnection remains
            }
            if c2 == s {
                continue;
            }
            let j = pos[c2] as usize;
            let t2 = order[(j + 1) % n];
            if t2 == c1 {
                continue;
            }
            // Replace edges (c1,s)+(c2,t2) with (c1,c2)+(s,t2).
            if d_c1_c2 + dist(s, t2) + 1e-4 < d_c1_s + dist(c2, t2) {
                reverse_arc(order, &mut pos, (i + 1) % n, j, &mut budget);
                for &c in &[c1, s, c2, t2] {
                    if !active[c] {
                        active[c] = true;
                        queue.push_back(c);
                    }
                }
                moved = true;
                break;
            }
        }
        if moved {
            // c1's edges changed — give it another look.
            if !active[c1] {
                active[c1] = true;
                queue.push_back(c1);
            }
        }
        if budget == 0 {
            break;
        }
    }
}

/// Reverse the cyclic segment `order[from..=to]` (forward), or its complement if that's shorter
/// (equivalent for an undirected cycle). Keeps `pos` in sync and debits `budget` by the work done.
fn reverse_arc(order: &mut [usize], pos: &mut [u32], from: usize, to: usize, budget: &mut u64) {
    let n = order.len();
    let inner = (to + n - from) % n + 1;
    let (mut a, mut b, len) = if inner * 2 <= n {
        (from, to, inner)
    } else {
        // Reverse the complementary arc [to+1 ..= from-1] instead.
        ((to + 1) % n, (from + n - 1) % n, n - inner)
    };
    for _ in 0..len / 2 {
        order.swap(a, b);
        pos[order[a]] = a as u32;
        pos[order[b]] = b as u32;
        a = (a + 1) % n;
        b = (b + n - 1) % n;
    }
    *budget = budget.saturating_sub(len as u64);
}

/// Uniform spatial hash over the points (≈1 point per cell), for fast nearest / k-nearest queries.
struct SpatialGrid {
    minx: f32,
    miny: f32,
    inv_cell: f32,
    cell: f32,
    cols: i32,
    rows: i32,
    cells: Vec<Vec<u32>>,
}

impl SpatialGrid {
    fn build(pts: &[(f32, f32)]) -> SpatialGrid {
        let (mut minx, mut miny, mut maxx, mut maxy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for &(x, y) in pts {
            minx = minx.min(x);
            miny = miny.min(y);
            maxx = maxx.max(x);
            maxy = maxy.max(y);
        }
        let w = (maxx - minx).max(1e-3);
        let h = (maxy - miny).max(1e-3);
        let cell = (w * h / pts.len() as f32).sqrt().max(1e-3);
        let cols = ((w / cell).ceil() as i32).max(1);
        let rows = ((h / cell).ceil() as i32).max(1);
        let mut cells = vec![Vec::new(); (cols * rows) as usize];
        let inv_cell = 1.0 / cell;
        for (i, &(x, y)) in pts.iter().enumerate() {
            let cx = (((x - minx) * inv_cell) as i32).clamp(0, cols - 1);
            let cy = (((y - miny) * inv_cell) as i32).clamp(0, rows - 1);
            cells[(cy * cols + cx) as usize].push(i as u32);
        }
        SpatialGrid { minx, miny, inv_cell, cell, cols, rows, cells }
    }

    #[inline]
    fn cell_of(&self, x: f32, y: f32) -> (i32, i32) {
        (
            (((x - self.minx) * self.inv_cell) as i32).clamp(0, self.cols - 1),
            (((y - self.miny) * self.inv_cell) as i32).clamp(0, self.rows - 1),
        )
    }

    /// Greedy nearest-neighbour tour, consuming a working copy of the grid: each visited point is
    /// removed from its cell so ring searches shrink as the tour grows.
    fn greedy_tour(&self, pts: &[(f32, f32)]) -> Vec<usize> {
        let n = pts.len();
        let mut cells = self.cells.clone();
        let remove = |cells: &mut Vec<Vec<u32>>, idx: u32, x: f32, y: f32| {
            let (cx, cy) = self.cell_of(x, y);
            let v = &mut cells[(cy * self.cols + cx) as usize];
            if let Some(p) = v.iter().position(|&q| q == idx) {
                v.swap_remove(p);
            }
        };
        let mut order = Vec::with_capacity(n);
        let mut cur = 0usize;
        remove(&mut cells, 0, pts[0].0, pts[0].1);
        order.push(0);
        for _ in 1..n {
            let (px, py) = pts[cur];
            let (ccx, ccy) = self.cell_of(px, py);
            let mut best = usize::MAX;
            let mut bestd = f32::MAX;
            let mut r = 0i32;
            loop {
                // Scan the ring of cells at Chebyshev radius r.
                for cy in (ccy - r).max(0)..=(ccy + r).min(self.rows - 1) {
                    for cx in (ccx - r).max(0)..=(ccx + r).min(self.cols - 1) {
                        if (cx - ccx).abs().max((cy - ccy).abs()) != r {
                            continue;
                        }
                        for &idx in &cells[(cy * self.cols + cx) as usize] {
                            let (x, y) = pts[idx as usize];
                            let d = (x - px) * (x - px) + (y - py) * (y - py);
                            if d < bestd {
                                bestd = d;
                                best = idx as usize;
                            }
                        }
                    }
                }
                // Any unscanned point is ≥ r·cell away; stop once that exceeds the best found.
                if best != usize::MAX {
                    let reach = r as f32 * self.cell;
                    if reach * reach > bestd {
                        break;
                    }
                }
                r += 1;
                if r > self.cols.max(self.rows) {
                    break;
                }
            }
            remove(&mut cells, best as u32, pts[best].0, pts[best].1);
            order.push(best);
            cur = best;
        }
        order
    }

    /// For every point, its `k` nearest neighbours (sorted ascending), flattened to `n*k`; unused
    /// slots are `u32::MAX`.
    fn knn(&self, pts: &[(f32, f32)], k: usize) -> Vec<u32> {
        let n = pts.len();
        let mut out = vec![u32::MAX; n * k];
        // Small insertion-sorted buffer of (dist², idx) per query — k is tiny.
        let mut buf: Vec<(f32, u32)> = Vec::with_capacity(k + 1);
        for i in 0..n {
            buf.clear();
            let (px, py) = pts[i];
            let (ccx, ccy) = self.cell_of(px, py);
            let mut r = 0i32;
            loop {
                for cy in (ccy - r).max(0)..=(ccy + r).min(self.rows - 1) {
                    for cx in (ccx - r).max(0)..=(ccx + r).min(self.cols - 1) {
                        if (cx - ccx).abs().max((cy - ccy).abs()) != r {
                            continue;
                        }
                        for &idx in &self.cells[(cy * self.cols + cx) as usize] {
                            if idx as usize == i {
                                continue;
                            }
                            let (x, y) = pts[idx as usize];
                            let d = (x - px) * (x - px) + (y - py) * (y - py);
                            if buf.len() == k && d >= buf[k - 1].0 {
                                continue;
                            }
                            let at = buf.partition_point(|e| e.0 < d);
                            buf.insert(at, (d, idx));
                            if buf.len() > k {
                                buf.pop();
                            }
                        }
                    }
                }
                // Stop once the ring is farther than our current k-th neighbour.
                if buf.len() == k {
                    let reach = r as f32 * self.cell;
                    if reach * reach > buf[k - 1].0 {
                        break;
                    }
                }
                r += 1;
                if r > self.cols.max(self.rows) {
                    break;
                }
            }
            for (s, &(_, idx)) in buf.iter().enumerate() {
                out[i * k + s] = idx;
            }
        }
        out
    }

    /// Remove self-intersections from the cyclic tour. Each pass buckets every edge into the grid
    /// cells its segment passes through, then for edges sharing a cell tests for a proper crossing;
    /// a crossing pair is uncrossed by the 2-opt reversal between them (which is always shorter, so
    /// it can't loop). Bucketing by traversed cells keeps a pass ≈O(n); a few passes converge.
    fn uncross(&self, pts: &[(f32, f32)], order: &mut [usize]) {
        let n = order.len();
        let mut pos = vec![0u32; n];
        for (p, &c) in order.iter().enumerate() {
            pos[c] = p as u32;
        }
        let mut buckets: Vec<Vec<u32>> = vec![Vec::new(); (self.cols * self.rows) as usize];
        let mut budget: u64 = 80 * n as u64;
        const MAX_PASSES: usize = 40;
        for _ in 0..MAX_PASSES {
            for b in buckets.iter_mut() {
                b.clear();
            }
            for p in 0..n {
                let a = pts[order[p]];
                let b = pts[order[(p + 1) % n]];
                self.traverse(a, b, |ci| buckets[ci].push(p as u32));
            }
            let mut fixed = false;
            'scan: for cell in &buckets {
                for u in 0..cell.len() {
                    for v in (u + 1)..cell.len() {
                        let (p, q) = (cell[u] as usize, cell[v] as usize);
                        let (lo, hi) = (p.min(q), p.max(q));
                        // Skip edges adjacent on the cycle (they share a vertex by construction).
                        if hi - lo <= 1 || (lo == 0 && hi == n - 1) {
                            continue;
                        }
                        let a = order[lo];
                        let b = order[(lo + 1) % n];
                        let c = order[hi];
                        let d = order[(hi + 1) % n];
                        if a == c || a == d || b == c || b == d {
                            continue;
                        }
                        if proper_cross(pts[a], pts[b], pts[c], pts[d]) {
                            reverse_arc(order, &mut pos, (lo + 1) % n, hi, &mut budget);
                            fixed = true;
                            if budget == 0 {
                                break 'scan;
                            }
                        }
                    }
                }
            }
            if !fixed || budget == 0 {
                break;
            }
        }
    }

    /// Call `f` once per grid cell the segment a→b passes through (Amanatides–Woo voxel traversal).
    /// Unlike point-sampling this visits *every* touched cell with no skips, so two crossing segments
    /// are guaranteed to meet in the cell containing their intersection — the uncrossing pass relies
    /// on that to never miss a crossing.
    fn traverse(&self, a: (f32, f32), b: (f32, f32), mut f: impl FnMut(usize)) {
        let inv = self.inv_cell;
        let (ax, ay) = ((a.0 - self.minx) * inv, (a.1 - self.miny) * inv);
        let (bx, by) = ((b.0 - self.minx) * inv, (b.1 - self.miny) * inv);
        let mut cx = (ax.floor() as i32).clamp(0, self.cols - 1);
        let mut cy = (ay.floor() as i32).clamp(0, self.rows - 1);
        let ecx = (bx.floor() as i32).clamp(0, self.cols - 1);
        let ecy = (by.floor() as i32).clamp(0, self.rows - 1);
        let (dx, dy) = (bx - ax, by - ay);
        let stepx = if dx > 0.0 { 1 } else { -1 };
        let stepy = if dy > 0.0 { 1 } else { -1 };
        // t (0..1 along the segment) to the next cell boundary, and to cross one full cell, per axis.
        let (mut t_max_x, t_delta_x) = if dx != 0.0 {
            let adx = dx.abs();
            let next = if dx > 0.0 { (cx + 1) as f32 - ax } else { ax - cx as f32 };
            (next / adx, 1.0 / adx)
        } else {
            (f32::INFINITY, f32::INFINITY)
        };
        let (mut t_max_y, t_delta_y) = if dy != 0.0 {
            let ady = dy.abs();
            let next = if dy > 0.0 { (cy + 1) as f32 - ay } else { ay - cy as f32 };
            (next / ady, 1.0 / ady)
        } else {
            (f32::INFINITY, f32::INFINITY)
        };
        for _ in 0..(self.cols + self.rows + 2) {
            f((cy * self.cols + cx) as usize);
            if cx == ecx && cy == ecy {
                break;
            }
            if t_max_x < t_max_y {
                t_max_x += t_delta_x;
                cx += stepx;
            } else {
                t_max_y += t_delta_y;
                cy += stepy;
            }
            if cx < 0 || cy < 0 || cx >= self.cols || cy >= self.rows {
                break;
            }
        }
    }
}

/// Do segments a→b and c→d properly cross (interiors intersect, not merely touch)? Collinear/shared-
/// endpoint cases return false — they don't produce the visible "X" we're removing.
fn proper_cross(a: (f32, f32), b: (f32, f32), c: (f32, f32), d: (f32, f32)) -> bool {
    let orient = |p: (f32, f32), q: (f32, f32), r: (f32, f32)| {
        (q.0 - p.0) * (r.1 - p.1) - (q.1 - p.1) * (r.0 - p.0)
    };
    let d1 = orient(c, d, a);
    let d2 = orient(c, d, b);
    let d3 = orient(a, b, c);
    let d4 = orient(a, b, d);
    ((d1 > 0.0) != (d2 > 0.0)) && (d1 != 0.0 && d2 != 0.0)
        && ((d3 > 0.0) != (d4 > 0.0)) && (d3 != 0.0 && d4 != 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_len(pts: &[(f32, f32)], order: &[usize]) -> f32 {
        order
            .windows(2)
            .map(|w| {
                let a = pts[w[0]];
                let b = pts[w[1]];
                ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
            })
            .sum()
    }

    #[test]
    fn solve_visits_every_point_once_and_shortens() {
        // A scattered cloud (deterministic): the tour must be a permutation, and 2-opt's path must
        // beat a naive index-order traversal by a wide margin.
        let mut rng = Rng::new(42);
        let pts: Vec<(f32, f32)> = (0..2000).map(|_| (rng.f32() * 200.0, rng.f32() * 200.0)).collect();
        let order = solve(&pts);
        assert_eq!(order.len(), pts.len());
        let mut seen = vec![false; pts.len()];
        for &i in &order {
            assert!(!seen[i], "point {i} visited twice");
            seen[i] = true;
        }
        let naive: Vec<usize> = (0..pts.len()).collect();
        assert!(
            path_len(&pts, &order) < path_len(&pts, &naive) * 0.2,
            "tour ({}) should be far shorter than index order ({})",
            path_len(&pts, &order),
            path_len(&pts, &naive),
        );
    }

    #[test]
    fn solve_handles_tiny_inputs() {
        assert_eq!(solve(&[(0.0, 0.0)]), vec![0]);
        assert_eq!(solve(&[(0.0, 0.0), (1.0, 1.0)]).len(), 2);
    }

    #[test]
    fn solve_has_no_self_intersections() {
        // The uncrossing pass must leave a planar (non-self-intersecting) path — that's the whole
        // point. Brute-force every non-adjacent edge pair of the open path.
        let mut rng = Rng::new(99);
        let pts: Vec<(f32, f32)> = (0..4000).map(|_| (rng.f32() * 150.0, rng.f32() * 150.0)).collect();
        let order = solve(&pts);
        let mut crossings = 0;
        for i in 0..order.len() - 1 {
            for j in (i + 2)..order.len() - 1 {
                let a = pts[order[i]];
                let b = pts[order[i + 1]];
                let c = pts[order[j]];
                let d = pts[order[j + 1]];
                if proper_cross(a, b, c, d) {
                    crossings += 1;
                }
            }
        }
        assert_eq!(crossings, 0, "tour still self-intersects {crossings} times");
    }

    /// A 48×48 radial gradient (dark centre → light edges) as an inkness grid, `invert` optional.
    fn gradient_grid(invert: bool) -> Grid {
        let (w, h) = (48usize, 48usize);
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - w as f32 / 2.0;
                let dy = y as f32 - h as f32 / 2.0;
                let v = ((dx * dx + dy * dy).sqrt() / (w as f32 / 2.0)).clamp(0.0, 1.0) * 255.0;
                let p = (y * w + x) * 4;
                rgba[p] = v as u8;
                rgba[p + 1] = v as u8;
                rgba[p + 2] = v as u8;
            }
        }
        Grid::build(&rgba, w, h, 60.0, 60.0, invert)
    }

    #[test]
    fn sample_is_deterministic_and_seed_varies() {
        let g = gradient_grid(false);
        assert_eq!(sample(&g, 1, 500), sample(&g, 1, 500), "same seed must reproduce");
        assert_ne!(sample(&g, 1, 500), sample(&g, 2, 500), "different seed must differ");
    }

    #[test]
    fn sample_follows_darkness_and_invert() {
        // Dark-centre gradient: points cluster near the centre; with invert they cluster at the edges.
        let mean_r = |g: &Grid| {
            let pts = sample(g, 3, 1500);
            let s: f32 = pts.iter().map(|&(x, y)| ((x - 30.0).powi(2) + (y - 30.0).powi(2)).sqrt()).sum();
            s / pts.len().max(1) as f32
        };
        assert!(mean_r(&gradient_grid(false)) < mean_r(&gradient_grid(true)), "invert should push points outward");
    }
}
