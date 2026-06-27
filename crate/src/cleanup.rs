//! Toolpath cleanup for *free* (group-0) strokes, run just before ordering. It is visually lossless
//! — it only removes redundancy and pen lifts:
//!   - **dedupe** coincident segments (shared edges drawn once — common in occluded SVG imports),
//!   - **chain** touching strokes into continuous polylines (fewer pen-up/pen-down cycles),
//!   - **drop collinear** interior points (smaller G-code).
//! Locked chains (nonzero `group`, e.g. handwriting) pass through untouched. Per-pen, so colours
//! never merge. The optimizer reorders the result afterwards, so output order here doesn't matter.

use crate::geom::{Point, Stroke};
use std::collections::HashMap;

/// Quantization for coincidence tests: 1 µm grid (well below any pen width).
const Q: f32 = 1000.0;
type Key = (i64, i64);
fn key(p: Point) -> Key {
    ((p.x * Q).round() as i64, (p.y * Q).round() as i64)
}

pub fn cleanup(strokes: &[Stroke]) -> Vec<Stroke> {
    let mut out: Vec<Stroke> = Vec::new();
    let mut by_pen: HashMap<u16, Vec<&Stroke>> = HashMap::new();
    for s in strokes {
        if s.group != 0 {
            out.push(s.clone()); // locked chain — leave exactly as-is
        } else if s.points.len() >= 2 {
            by_pen.entry(s.pen).or_default().push(s);
        }
    }
    // Stable pen order for determinism (HashMap iteration is not ordered).
    let mut pens: Vec<u16> = by_pen.keys().copied().collect();
    pens.sort_unstable();
    for pen in pens {
        out.extend(clean_pen(&by_pen[&pen], pen));
    }
    out
}

fn clean_pen(strokes: &[&Stroke], pen: u16) -> Vec<Stroke> {
    // 1. Deduped undirected segments + a representative point per vertex.
    let mut coord: HashMap<Key, Point> = HashMap::new();
    let mut seen: HashMap<(Key, Key), usize> = HashMap::new();
    let mut segs: Vec<(Key, Key)> = Vec::new();
    for s in strokes {
        for w in s.points.windows(2) {
            let (ka, kb) = (key(w[0]), key(w[1]));
            if ka == kb {
                continue; // zero-length
            }
            coord.entry(ka).or_insert(w[0]);
            coord.entry(kb).or_insert(w[1]);
            let uk = if ka <= kb { (ka, kb) } else { (kb, ka) };
            seen.entry(uk).or_insert_with(|| {
                segs.push((ka, kb));
                segs.len() - 1
            });
        }
    }
    if segs.is_empty() {
        return Vec::new();
    }

    // 2. Adjacency: vertex → incident segment indices.
    let mut adj: HashMap<Key, Vec<usize>> = HashMap::new();
    for (i, &(a, b)) in segs.iter().enumerate() {
        adj.entry(a).or_default().push(i);
        adj.entry(b).or_default().push(i);
    }
    let pt = |k: Key| coord[&k];
    // Pick the unused segment at vertex `v` that best continues direction `dir` (most collinear),
    // tie-broken by lowest index for determinism; returns (seg index, far vertex).
    let best_next = |v: Key, dir: Option<(f32, f32)>, used: &[bool]| -> Option<(usize, Key)> {
        let mut best: Option<(usize, Key, f32)> = None;
        for &i in adj.get(&v)? {
            if used[i] {
                continue;
            }
            let (a, b) = segs[i];
            let far = if a == v { b } else { a };
            let (pv, pf) = (pt(v), pt(far));
            let mut len = ((pf.x - pv.x).powi(2) + (pf.y - pv.y).powi(2)).sqrt();
            if len < 1e-9 {
                len = 1e-9;
            }
            // Score = cos of turn angle (1 = straight). No prior direction ⇒ all equal.
            let score = match dir {
                Some((dx, dy)) => ((pf.x - pv.x) / len) * dx + ((pf.y - pv.y) / len) * dy,
                None => 0.0,
            };
            if best.map_or(true, |(_, _, bs)| score > bs + 1e-9) {
                best = Some((i, far, score));
            }
        }
        best.map(|(i, far, _)| (i, far))
    };

    // 3. Greedily chain segments into polylines, extending each end along the straightest route.
    let mut used = vec![false; segs.len()];
    let mut polylines: Vec<Vec<Key>> = Vec::new();
    for seed in 0..segs.len() {
        if used[seed] {
            continue;
        }
        used[seed] = true;
        let (a, b) = segs[seed];
        let mut chain: std::collections::VecDeque<Key> = std::collections::VecDeque::from([a, b]);
        // Extend the back.
        loop {
            let v = *chain.back().unwrap();
            let prev = chain[chain.len() - 2];
            let (pv, pp) = (pt(v), pt(prev));
            let mut l = ((pv.x - pp.x).powi(2) + (pv.y - pp.y).powi(2)).sqrt();
            if l < 1e-9 {
                l = 1e-9;
            }
            let dir = ((pv.x - pp.x) / l, (pv.y - pp.y) / l);
            match best_next(v, Some(dir), &used) {
                Some((i, far)) => {
                    used[i] = true;
                    chain.push_back(far);
                }
                None => break,
            }
        }
        // Extend the front.
        loop {
            let v = *chain.front().unwrap();
            let next = chain[1];
            let (pv, pn) = (pt(v), pt(next));
            let mut l = ((pv.x - pn.x).powi(2) + (pv.y - pn.y).powi(2)).sqrt();
            if l < 1e-9 {
                l = 1e-9;
            }
            let dir = ((pv.x - pn.x) / l, (pv.y - pn.y) / l);
            match best_next(v, Some(dir), &used) {
                Some((i, far)) => {
                    used[i] = true;
                    chain.push_front(far);
                }
                None => break,
            }
        }
        polylines.push(chain.into_iter().collect());
    }

    // 4. Materialize, dropping collinear interior points.
    polylines
        .into_iter()
        .filter_map(|keys| {
            let pts: Vec<Point> = keys.into_iter().map(pt).collect();
            let merged = drop_collinear(&pts);
            if merged.len() >= 2 {
                Some(Stroke { points: merged, pen, reversible: true, group: 0 })
            } else {
                None
            }
        })
        .collect()
}

/// Remove interior points that are (near-)collinear with their neighbours. Tolerance is the
/// perpendicular deviation in mm; tiny so curves are preserved and only redundant points on straight
/// runs (rect edges, RDP-flattened lines) are dropped.
fn drop_collinear(pts: &[Point]) -> Vec<Point> {
    const TOL: f32 = 2e-3;
    if pts.len() <= 2 {
        return pts.to_vec();
    }
    let mut out = vec![pts[0]];
    for i in 1..pts.len() - 1 {
        let a = *out.last().unwrap();
        let b = pts[i];
        let c = pts[i + 1];
        let (dx, dy) = (c.x - a.x, c.y - a.y);
        let len = (dx * dx + dy * dy).sqrt();
        let dev = if len < 1e-9 {
            ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt()
        } else {
            ((b.x - a.x) * dy - (b.y - a.y) * dx).abs() / len
        };
        if dev > TOL {
            out.push(b);
        }
    }
    out.push(pts[pts.len() - 1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(pen: u16, pts: &[(f32, f32)]) -> Stroke {
        Stroke {
            points: pts.iter().map(|&(x, y)| Point { x, y, pressure: 1.0 }).collect(),
            pen,
            reversible: true,
            group: 0,
        }
    }
    fn total_points(v: &[Stroke]) -> usize {
        v.iter().map(|s| s.points.len()).sum()
    }

    #[test]
    fn joins_touching_strokes() {
        // Two strokes meeting end-to-start → one continuous polyline (one fewer pen lift).
        let out = cleanup(&[s(0, &[(0.0, 0.0), (1.0, 0.0)]), s(0, &[(1.0, 0.0), (2.0, 0.0)])]);
        assert_eq!(out.len(), 1, "touching strokes chain into one");
    }

    #[test]
    fn dedupes_shared_edge() {
        // Two unit squares sharing the edge x=1: the shared edge must be drawn exactly once, and no
        // segment may appear twice anywhere in the output.
        let sq1 = s(0, &[(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0), (0.0, 0.0)]);
        let sq2 = s(0, &[(1.0, 0.0), (2.0, 0.0), (2.0, 1.0), (1.0, 1.0), (1.0, 0.0)]);
        let out = cleanup(&[sq1, sq2]);
        let mut seen = std::collections::HashSet::new();
        for st in &out {
            for w in st.points.windows(2) {
                let uk = {
                    let (a, b) = (key(w[0]), key(w[1]));
                    if a <= b { (a, b) } else { (b, a) }
                };
                assert!(seen.insert(uk), "a segment was drawn twice");
            }
        }
        assert!(total_points(&out) < 10, "deduped + collinear-merged, not the naive 10 input points");
    }

    #[test]
    fn drops_collinear_points() {
        let out = cleanup(&[s(0, &[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (3.0, 0.0)])]);
        assert_eq!(total_points(&out), 2, "straight run collapses to its endpoints");
    }

    #[test]
    fn keeps_pens_separate_and_chains_untouched() {
        let chain = Stroke { group: 7, ..s(0, &[(0.0, 0.0), (1.0, 0.0)]) };
        let out = cleanup(&[s(0, &[(0.0, 0.0), (1.0, 0.0)]), s(1, &[(0.0, 0.0), (1.0, 0.0)]), chain]);
        assert_eq!(out.len(), 3, "two pens stay separate; the locked chain passes through");
    }
}
