//! **Topographic map** (`contourmap`): treat inkness as elevation and draw iso-tone lines at
//! `levels` evenly-spaced thresholds (marching squares), like a contour map of the image's light.
//! Nested loops trace the form as topography. Raw marching-squares output is a soup of one-segment-
//! per-cell, so we chain co-incident segments into long polylines first (few pen lifts, smooth runs).

use std::collections::HashMap;

use super::{pt, stroke, Grid, Params};
use crate::geom::Stroke;

pub fn contourmap(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let levels = p.levels.clamp(1, 12) as usize;
    let mut out = Vec::new();
    for k in 1..=levels {
        let v = k as f32 / (levels as f32 + 1.0);
        marching_squares(grid, v, &mut out);
    }
    out
}

/// Marching squares at iso-value `v`, chained into polylines, appended to `out`.
fn marching_squares(grid: &Grid, v: f32, out: &mut Vec<Stroke>) {
    let mut ch = Chainer::default();
    let (sx, sy) = (grid.sx, grid.sy);
    for y in 0..grid.h - 1 {
        for x in 0..grid.w - 1 {
            let tl = grid.at(x, y);
            let tr = grid.at(x + 1, y);
            let br = grid.at(x + 1, y + 1);
            let bl = grid.at(x, y + 1);
            let case = (tl >= v) as u8
                | (((tr >= v) as u8) << 1)
                | (((br >= v) as u8) << 2)
                | (((bl >= v) as u8) << 3);
            if case == 0 || case == 15 {
                continue;
            }
            // Edge crossing points (mm), interpolated where the iso-value cuts each cell edge.
            let fx = x as f32;
            let fy = y as f32;
            let p_top = ((fx + lerp(tl, tr, v)) * sx, fy * sy);
            let p_right = ((fx + 1.0) * sx, (fy + lerp(tr, br, v)) * sy);
            let p_bottom = ((fx + lerp(bl, br, v)) * sx, (fy + 1.0) * sy);
            let p_left = (fx * sx, (fy + lerp(tl, bl, v)) * sy);
            // Connect edges per case (T,R,B,L). Saddles (5,10) emit two segments.
            match case {
                1 | 14 => ch.seg(p_left, p_top),
                2 | 13 => ch.seg(p_top, p_right),
                3 | 12 => ch.seg(p_left, p_right),
                4 | 11 => ch.seg(p_right, p_bottom),
                6 | 9 => ch.seg(p_top, p_bottom),
                7 | 8 => ch.seg(p_left, p_bottom),
                5 => {
                    ch.seg(p_left, p_top);
                    ch.seg(p_right, p_bottom);
                }
                10 => {
                    ch.seg(p_top, p_right);
                    ch.seg(p_bottom, p_left);
                }
                _ => {}
            }
        }
    }
    ch.emit(out);
}

/// Fraction along an edge where value `v` falls between corner values `a`→`b`.
fn lerp(a: f32, b: f32, v: f32) -> f32 {
    if (b - a).abs() < 1e-6 {
        0.5
    } else {
        ((v - a) / (b - a)).clamp(0.0, 1.0)
    }
}

/// Welds marching-squares segments (which share endpoints exactly) into long polylines so each iso
/// line plots as a few continuous strokes rather than thousands of one-cell stubs.
#[derive(Default)]
struct Chainer {
    pool: Vec<(f32, f32)>,
    key2idx: HashMap<(i32, i32), usize>,
    segs: Vec<(usize, usize)>,
}

const Q: f32 = 1.0 / crate::tess::COINCIDENT_TOL; // 1µm — shared endpoints hash equal

impl Chainer {
    fn point(&mut self, x: f32, y: f32) -> usize {
        let key = ((x * Q).round() as i32, (y * Q).round() as i32);
        if let Some(&i) = self.key2idx.get(&key) {
            return i;
        }
        let i = self.pool.len();
        self.pool.push((x, y));
        self.key2idx.insert(key, i);
        i
    }
    fn seg(&mut self, a: (f32, f32), b: (f32, f32)) {
        let ia = self.point(a.0, a.1);
        let ib = self.point(b.0, b.1);
        if ia != ib {
            self.segs.push((ia, ib));
        }
    }
    fn emit(self, out: &mut Vec<Stroke>) {
        // Point → incident segment indices.
        let mut adj: Vec<Vec<usize>> = vec![Vec::new(); self.pool.len()];
        for (i, &(a, b)) in self.segs.iter().enumerate() {
            adj[a].push(i);
            adj[b].push(i);
        }
        let other = |s: (usize, usize), p: usize| if s.0 == p { s.1 } else { s.0 };
        let mut used = vec![false; self.segs.len()];
        // Walk to extend a chain from endpoint `end`, consuming segments.
        let grow = |chain: &mut Vec<usize>,
                    mut end: usize,
                    used: &mut [bool],
                    adj: &[Vec<usize>],
                    segs: &[(usize, usize)]| loop {
            let next = adj[end].iter().copied().find(|&si| !used[si]);
            match next {
                Some(si) => {
                    used[si] = true;
                    end = other(segs[si], end);
                    chain.push(end);
                }
                None => break,
            }
        };
        for i in 0..self.segs.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let (a, b) = self.segs[i];
            let mut chain = vec![a, b];
            grow(&mut chain, b, &mut used, &adj, &self.segs);
            // Extend the other way: reverse so the open end is last, then keep walking.
            chain.reverse();
            let end = *chain.last().unwrap();
            grow(&mut chain, end, &mut used, &adj, &self.segs);
            if chain.len() >= 2 {
                out.push(stroke(chain.iter().map(|&pi| pt(self.pool[pi].0, self.pool[pi].1)).collect()));
            }
        }
    }
}
