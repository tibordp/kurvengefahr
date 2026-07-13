//! Fermat-spiral fill (pattern `fermat`): the whole shape as ONE continuous closed line, via
//! **Connected Fermat Spirals** (Zhao et al., SIGGRAPH 2016) over the same in-house iso-distance
//! contours the concentric fill uses.
//!
//! Structure: contour levels at `spacing`, `2*spacing`, ... (first ring one spacing inside the
//! outline, so stroke + fill plot at an even pitch) form a nesting forest; maximal single-child
//! runs are "chains". Each chain becomes a Fermat spiral: every ring is an exact contour lap
//! minus a small cut, the in-arm walks rings 0, 2, 4, ... bridging through the cut of each
//! skipped ring, a short link at the deep end crosses to the out-arm, which returns through
//! rings ..., 3, 1 - so the curve enters AND exits at the chain's outer boundary, one spacing
//! apart. That adjacency is what makes regions composable: where a ring splits into lobes, each
//! lobe's spiral is spliced into the branch ring's lap as a detour, the whole tree plots as one
//! stroke, and the two ends close into a loop. Holes get a chain per side (an annulus has no
//! single interior point to spiral to).
//!
//! The load-bearing invariants, all bought by construction rather than tuning:
//!
//! - Laps are exact nested contours; each contour is crossed only inside its own cut, by exactly
//!   one bridge; bridges are parallel diagonals of the seam corridor (`q_i -> m_{i+1} -> p_{i+2}`).
//! - The seam (`p`) and cut-end (`q`) ladders are both built BOTTOM-UP by nearest-point
//!   projection from the ring below: going outward each step is at most one spacing (the inner
//!   ring is enclosed and the distance field is 1-Lipschitz), so neither ladder can teleport
//!   across a bay - the failure mode of every top-down or arc-offset variant tried before.
//! - The seam is seeded on the deepest ring where the cut window stays spatially extended (a
//!   straight flank); an arbitrary seed can straddle a hairpin tip and chord the deep link.
//! - Rings shorter than 2.5*spacing (medial-axis slivers) are dropped: they have no meaningful
//!   corridor geometry and plot as sub-pen-width squiggles.
//! - Output strokes are relaxed by the smooth effect's core (endpoint-free, since the loop is
//!   closed first), which also bounds every output segment to the subdivision resolution.
//!
//! Known limit: adversarially concave shapes can still self-intersect locally where the seam
//! corridor crosses a feature thinner than the cut width.

use crate::geom::{Point, Stroke};
use crate::hatch::{distance_contours, signed_dist};
use crate::poly::{pt, P};

fn dist2(a: P, b: P) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    dx * dx + dy * dy
}

fn stroke(points: Vec<Point>) -> Stroke {
    Stroke {
        points,
        pen: 0,
        reversible: true,
        group: 0,
    }
}

/// A contour ring prepared for lap-walking: deduped, wound shoelace-positive, with cumulative
/// arc lengths. Positions on the ring are scalar arc lengths in `[0, total)`.
struct Ring {
    pts: Vec<P>,
    cum: Vec<f32>, // cum[i] = arc length from vertex 0 to vertex i
    total: f32,
    hole: bool,
}

impl Ring {
    fn new(pts: Vec<P>, hole: bool) -> Ring {
        let n = pts.len();
        let mut cum = Vec::with_capacity(n);
        let mut acc = 0.0;
        for i in 0..n {
            cum.push(acc);
            acc += dist2(pts[i], pts[(i + 1) % n]).sqrt();
        }
        Ring {
            pts,
            cum,
            total: acc.max(1e-6),
            hole,
        }
    }

    fn wrap(&self, a: f32) -> f32 {
        a.rem_euclid(self.total)
    }

    /// Vertex index whose segment contains arc position `a`.
    fn seg_of(&self, a: f32) -> usize {
        let a = self.wrap(a);
        match self.cum.partition_point(|&c| c <= a) {
            0 => 0,
            i => i - 1,
        }
    }

    fn point_at(&self, a: f32) -> P {
        let a = self.wrap(a);
        let i = self.seg_of(a);
        let j = (i + 1) % self.pts.len();
        let len = (self.cum.get(i + 1).copied().unwrap_or(self.total) - self.cum[i]).max(1e-12);
        let t = ((a - self.cum[i]) / len).clamp(0.0, 1.0);
        let (p, q) = (self.pts[i], self.pts[j]);
        (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t)
    }

    /// Arc position of the closest point on the ring to `p` (full projection scan).
    fn nearest_arc(&self, p: P) -> f32 {
        let n = self.pts.len();
        let (mut best, mut barc) = (f32::INFINITY, 0.0);
        for i in 0..n {
            let (a, b) = (self.pts[i], self.pts[(i + 1) % n]);
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let l2 = dx * dx + dy * dy;
            let t = if l2 <= 1e-12 {
                0.0
            } else {
                (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0)
            };
            let q = (a.0 + t * dx, a.1 + t * dy);
            let d = dist2(p, q);
            if d < best {
                best = d;
                barc = self.cum[i] + t * l2.sqrt();
            }
        }
        self.wrap(barc)
    }

    /// Distance from `p` to the ring.
    fn dist(&self, p: P) -> f32 {
        dist2(p, self.point_at(self.nearest_arc(p))).sqrt()
    }

    /// Append the walk from arc `from` travelling `len` of arc in direction `dir` (±1),
    /// including both endpoints and every ring vertex in between.
    fn emit_span(&self, from: f32, len: f32, dir: f32, out: &mut Vec<P>) {
        let n = self.pts.len();
        push_pt(out, self.point_at(from));
        let mut travelled = 0.0;
        let mut i = self.seg_of(from);
        // First vertex strictly ahead of `from` in travel direction.
        let (mut v, step): (usize, isize) = if dir > 0.0 {
            ((i + 1) % n, 1)
        } else {
            // seg_of's vertex i is at-or-behind `from` going forward, so it is the first vertex
            // ahead when walking backward — unless we're exactly on it.
            if (self.wrap(from) - self.cum[i]).abs() < 1e-6 {
                i = (i + n - 1) % n;
            }
            (i, -1)
        };
        let mut guard = 2 * n + 4;
        loop {
            let varc = self.cum[v];
            let ahead = if dir > 0.0 {
                self.wrap(varc - from)
            } else {
                self.wrap(from - varc)
            };
            if ahead >= len || ahead <= 0.0 || guard == 0 {
                break;
            }
            if ahead > travelled {
                push_pt(out, self.pts[v]);
                travelled = ahead;
            }
            v = ((v as isize + step).rem_euclid(n as isize)) as usize;
            guard -= 1;
        }
        push_pt(out, self.point_at(from + dir * len));
    }
}

/// Push, dropping sub-micron duplicates so piece seams don't double points.
fn push_pt(out: &mut Vec<P>, p: P) {
    if out.last().is_none_or(|&q| dist2(q, p) > 1e-10) {
        out.push(p);
    }
}

/// Dedup + orient a raw closed polyline; `None` if degenerate.
fn prep(mut pts: Vec<P>) -> Option<Vec<P>> {
    pts.dedup_by(|a, b| dist2(*a, *b) < 1e-10);
    while pts.len() > 1 && dist2(pts[0], *pts.last().unwrap()) < 1e-10 {
        pts.pop();
    }
    if pts.len() < 3 {
        return None;
    }
    let mut area = 0.0;
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        area += a.0 * b.1 - b.0 * a.1;
    }
    if area < 0.0 {
        pts.reverse();
    }
    Some(pts)
}

/// Even-odd point-in-polygon against a single ring.
fn inside(ring: &[P], x: f32, y: f32) -> bool {
    let n = ring.len();
    let mut ins = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = ring[i];
        let (xj, yj) = ring[j];
        if (yi > y) != (yj > y) && x < xi + (y - yi) / (yj - yi) * (xj - xi) {
            ins = !ins;
        }
        j = i;
    }
    ins
}

/// Node address in the level structure.
type Id = (usize, usize);

struct Forest {
    levels: Vec<Vec<Ring>>,
    child: Vec<Vec<Vec<usize>>>, // children (next-level ring indices) of each ring
    parent: Vec<Vec<Option<usize>>>,
}

/// A chain is a maximal single-child run; `rings` are level-consecutive; `kids` are the chain
/// starts hanging off the deepest ring (empty for leaves).
struct Chain {
    rings: Vec<Id>,
    kids: Vec<Id>,
}

pub fn fill(rings32: &[Vec<P>], spacing: f32, out: &mut Vec<Stroke>) {
    if spacing <= 1e-3 {
        return;
    }
    // -- Levels: the concentric fill's iso-distance contours, first ring one spacing inside the
    // outline — with the stroke drawn, boundary → lap 1 → lap 2 then has an even pitch of
    // exactly one spacing (and it matches where the concentric fill starts). Polarity of a
    // contour ring: sample just inside the ring polygon — deeper than its level means the ring
    // encloses the deep side (outer-side, shrinking); shallower means it encloses the hole
    // (growing).
    let mut levels: Vec<Vec<Ring>> = Vec::new();
    for (li, level) in distance_contours(rings32, spacing).into_iter().enumerate() {
        let lvl_d = (li + 1) as f32 * spacing;
        let mut v: Vec<Ring> = Vec::new();
        for line in level {
            let closed =
                line.len() >= 4 && dist2(line[0], *line.last().unwrap()).sqrt() < spacing * 0.5;
            if !closed {
                continue; // stitch fragment: marching noise, already rare after filtering
            }
            let Some(p) = prep(line) else { continue };
            // Interior sample: nudge off the LONGEST edge (short marching edges have noisy
            // directions) and pick the side that is polygon-inside — no winding assumptions.
            let li_max = (0..p.len())
                .max_by(|&x, &y| {
                    dist2(p[x], p[(x + 1) % p.len()])
                        .partial_cmp(&dist2(p[y], p[(y + 1) % p.len()]))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .unwrap_or(0);
            let (a, b) = (p[li_max], p[(li_max + 1) % p.len()]);
            let (dx, dy) = (b.0 - a.0, b.1 - a.1);
            let l = (dx * dx + dy * dy).sqrt().max(1e-9);
            let eps = (spacing * 0.2).min(l * 0.5).min(1.0);
            let mid = ((a.0 + b.0) * 0.5, (a.1 + b.1) * 0.5);
            let s1 = (mid.0 - dy / l * eps, mid.1 + dx / l * eps);
            let s2 = (mid.0 + dy / l * eps, mid.1 - dx / l * eps);
            let interior = if inside(&p, s1.0, s1.1) { s1 } else { s2 };
            let hole = signed_dist(rings32, interior.0, interior.1) < lvl_d;
            let ring = Ring::new(p, hole);
            // Medial-axis slivers (hairpin rings barely longer than the concentric fill's
            // 1.5·spacing floor) have no meaningful cut/bridge geometry and plot as sub-pen-width
            // squiggles — drop them outright.
            if ring.total >= spacing * 2.5 {
                v.push(ring);
            }
        }
        levels.push(v);
    }

    // -- Parent links: same-polarity containment (outer rings shrink, hole rings grow) plus a
    // geometric adjacency guard — adjacent contour levels sit one spacing apart, so a nested
    // ring that strays much further belongs to a collapsing band, not this chain.
    let nl = levels.len();
    let mut parent: Vec<Vec<Option<usize>>> = levels.iter().map(|l| vec![None; l.len()]).collect();
    let mut child: Vec<Vec<Vec<usize>>> =
        levels.iter().map(|l| vec![Vec::new(); l.len()]).collect();
    for k in 1..nl {
        for i in 0..levels[k].len() {
            let c = &levels[k][i];
            let mut par: Option<usize> = None;
            let mut multi = false;
            for (jp, p) in levels[k - 1].iter().enumerate() {
                if p.hole != c.hole {
                    continue;
                }
                let mut linked = if c.hole {
                    inside(&c.pts, p.pts[0].0, p.pts[0].1)
                } else {
                    inside(&p.pts, c.pts[0].0, c.pts[0].1)
                };
                if linked {
                    let stride = (c.pts.len() / 24).max(1);
                    linked = c
                        .pts
                        .iter()
                        .step_by(stride)
                        .all(|&q| p.dist(q) <= spacing * 1.9);
                }
                if linked {
                    if par.is_some() {
                        multi = true;
                    }
                    par = Some(jp);
                }
            }
            if !multi {
                if let Some(jp) = par {
                    parent[k][i] = Some(jp);
                    child[k - 1][jp].push(i);
                }
            }
        }
    }
    let forest = Forest {
        levels,
        child,
        parent,
    };

    // -- Chains: start wherever there is no unique continuing parent, follow unique-child links.
    for k0 in 0..nl {
        for i0 in 0..forest.levels[k0].len() {
            let continued = match forest.parent[k0][i0] {
                Some(jp) => forest.child[k0 - 1][jp].len() == 1,
                None => false,
            };
            if continued {
                continue; // interior of some chain
            }
            let chain = collect_chain(&forest, (k0, i0));
            // Only roots start strokes; chains hanging off a branch are reached via detours.
            let is_root = forest.parent[k0][i0].is_none();
            if is_root {
                let mut pts: Vec<P> = Vec::new();
                let seam = chain_seam(&forest, &chain, spacing);
                build_curve(&forest, &chain, &seam, 1.0, spacing, &mut pts);
                if pts.len() >= 2 {
                    // The curve's ends sit one spacing apart on the seam ladder (entry on the
                    // first ring, exit on the second) — close the loop across that rung, which
                    // no bridge occupies, so the plot has no dangling tails.
                    let first = pts[0];
                    pts.push(first);
                    let points: Vec<Point> = pts.into_iter().map(|p| pt(p.0, p.1)).collect();
                    // Iron out the contour-grid jags (≈ a third of the spacing) with the smooth
                    // effect's subdivide-and-relax, scaled to the spacing so real geometry
                    // survives; periodic relaxation rounds the closing junction too.
                    let res = (spacing * 0.25).clamp(0.4, 2.0);
                    let smoothed = crate::effects::smooth::smooth_pts(&points, res, 0.5, 10, true);
                    out.push(stroke(smoothed));
                }
            }
        }
    }
}

fn collect_chain(f: &Forest, start: Id) -> Chain {
    let (mut k, mut i) = start;
    let mut rings = vec![(k, i)];
    loop {
        let kids = &f.child[k][i];
        if kids.len() == 1 {
            k += 1;
            i = kids[0];
            rings.push((k, i));
        } else {
            let kids = kids.iter().map(|&ci| (k + 1, ci)).collect();
            return Chain { rings, kids };
        }
    }
}

/// The chain's seam, computed **bottom-up**: the deepest ring seeds it, and each ring's seam
/// point is the nearest point to its child's. In that direction every step is at most one
/// spacing (the child ring is enclosed, and the distance field is 1-Lipschitz), so the seam can
/// never teleport across a bay — computed top-down it can, when a contour retreats out of a
/// shallow lobe between two levels, and every bridge attached to it becomes a chord across the
/// interior.
fn chain_seam(f: &Forest, chain: &Chain, spacing: f32) -> Vec<f32> {
    let rs: Vec<&Ring> = chain.rings.iter().map(|&(k, i)| &f.levels[k][i]).collect();
    let n = rs.len() - 1;
    let mut p = vec![0.0f32; n + 1];
    // Seed on the deepest ring where the cut window lies on a straight flank: an arbitrary seed
    // can land the corridor across a hairpin tip, where an arc offset teleports spatially and
    // the deep link would chord across the shape. Score = how spatially extended the window
    // stays in both directions.
    let rn = rs[n];
    let w = (spacing * 2.2).min(rn.total * 0.35);
    let steps = ((rn.total / (spacing * 0.5)) as usize).clamp(16, 256);
    let mut best = (f32::NEG_INFINITY, 0.0f32);
    for si in 0..steps {
        let a = rn.total * si as f32 / steps as f32;
        let c = rn.point_at(a);
        let score = dist2(c, rn.point_at(a - w)).min(dist2(c, rn.point_at(a + w)));
        if score > best.0 {
            best = (score, a);
        }
    }
    p[n] = best.1;
    for i in (0..n).rev() {
        p[i] = rs[i].nearest_arc(rs[i + 1].point_at(p[i + 1]));
    }
    p
}

/// Build the Fermat spiral for one chain, splicing child chains into the deepest ring's lap.
/// `p` is the chain's seam (from `chain_seam`); `dir` is the travel/cut orientation (children
/// get the mirror of their parent's local travel direction so their exit emerges ahead of the
/// entry along the parent lap). The curve starts at p₀ and ends at p₁ (ring 1's seam), one
/// spacing inside the entry — that adjacency is what lets a parent splice this whole subtree in
/// as a detour.
fn build_curve(f: &Forest, chain: &Chain, p: &[f32], dir: f32, spacing: f32, out: &mut Vec<P>) {
    let rs: Vec<&Ring> = chain.rings.iter().map(|&(k, i)| &f.levels[k][i]).collect();
    let n = rs.len() - 1; // deepest ring index (0-based)

    // Corridor: the cut end `q` sits `b` of arc behind `p` (in `dir` terms); `m` is the cut's
    // middle, the waypoint bridges pass through. Like the seam, the q-chain is built BOTTOM-UP by
    // projection — a pure arc offset misaligns when ring sizes differ wildly (35% of a tiny
    // innermost ring is on its far side), and the deep link and bridges would slash across laps.
    // The projected width is clamped so the corridor neither collapses nor swallows small rings.
    let mut b = vec![0.0f32; n + 1];
    let mut q = vec![0.0f32; n + 1];
    {
        b[n] = (spacing * 2.2).min(rs[n].total * 0.35);
        q[n] = rs[n].wrap(p[n] - dir * b[n]);
        for i in (0..n).rev() {
            // The cut-end ladder follows real projections (like the seam), so q stays radially
            // above q of the ring below and the deep link/bridges stay short. Fall back to a
            // fixed offset only if the ladders genuinely diverged (a concave lobe between them)
            // or the cut collapsed.
            let proj = rs[i].nearest_arc(rs[i + 1].point_at(q[i + 1]));
            let raw = (dir * (p[i] - proj)).rem_euclid(rs[i].total);
            let lo = (spacing * 1.2).min(rs[i].total * 0.3);
            let hi = (spacing * 5.0).min(rs[i].total * 0.45);
            b[i] = if raw < lo || raw > hi {
                (spacing * 2.2).min(rs[i].total * 0.35)
            } else {
                raw
            };
            q[i] = rs[i].wrap(p[i] - dir * b[i]);
        }
    }
    let m: Vec<f32> = (0..=n)
        .map(|i| rs[i].wrap(p[i] - dir * 0.5 * b[i]))
        .collect();

    // Child chains, anchored where each child's own (bottom-up) seam entry projects onto the
    // deepest ring — the entry bridge is then one spacing, wherever the child sits.
    let deep_travel = if n.is_multiple_of(2) { dir } else { -dir }; // in-arm laps travel `dir`, out-arm laps −`dir`
    let lap_from_deep = if n.is_multiple_of(2) { p[n] } else { q[n] };
    let mut detours: Vec<(f32, Chain, Vec<f32>)> = chain
        .kids
        .iter()
        .map(|&kid| {
            let kchain = collect_chain(f, kid);
            let kseam = chain_seam(f, &kchain, spacing);
            let kp0 = f.levels[kid.0][kid.1].point_at(kseam[0]);
            let arc = rs[n].nearest_arc(kp0);
            let t = if deep_travel > 0.0 {
                rs[n].wrap(arc - lap_from_deep)
            } else {
                rs[n].wrap(lap_from_deep - arc)
            };
            (t, kchain, kseam)
        })
        .collect();
    detours.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Emit one lap, splicing detours when this is the deepest ring.
    let lap = |i: usize, travel: f32, from: f32, out: &mut Vec<P>| {
        let len = rs[i].total - b[i];
        if i < n || detours.is_empty() {
            rs[i].emit_span(from, len, travel, out);
            return;
        }
        let mut cur = 0.0; // arc travelled along this lap
        for (t, kchain, kseam) in &detours {
            // Never skip a child: overlapping detour anchors just splice from where we are.
            let t = t.clamp(0.0, len - 1e-3).max(cur);
            if t > cur {
                rs[i].emit_span(rs[i].wrap(from + travel * cur), t - cur, travel, out);
                cur = t;
            }
            let child_dir = -travel; // child cut opens ahead of the parent's travel
            let (ck, ci) = kchain.rings[0];
            let cr = &f.levels[ck][ci];
            push_pt(out, cr.point_at(kseam[0]));
            build_curve(f, kchain, kseam, child_dir, spacing, out);
            // Exit the child through the middle of its outer cut, then resume a bit ahead.
            push_pt(
                out,
                cr.point_at(cr.wrap(kseam[0] - child_dir * (spacing * 0.6).min(cr.total * 0.15))),
            );
            let resume = (cur + spacing).min(len);
            cur = resume;
        }
        rs[i].emit_span(rs[i].wrap(from + travel * cur), len - cur, travel, out);
    };

    // In-arm: rings 0, 2, 4, … travelling `dir`; bridge q_k → m_{k+1} → p_{k+2}.
    let mut k = 0;
    loop {
        lap(k, dir, p[k], out);
        if k + 2 > n {
            break;
        }
        push_pt(out, rs[k + 1].point_at(m[k + 1]));
        push_pt(out, rs[k + 2].point_at(p[k + 2]));
        k += 2;
    }
    if n == 0 {
        return; // single ring: enter at p0, leave at q0
    }
    // Deep link between the two arms' free ends: q of the deepest in-arm ring to q of the
    // deepest out-arm ring (radially adjacent, inside the corridor).
    let last_in = k; // n or n-1
    let last_out = if last_in == n { n - 1 } else { n };
    push_pt(out, rs[last_out].point_at(q[last_out]));
    // Out-arm: rings last_out, last_out-2, …, 1, travelled backward; bridges reversed
    // (p_j → m_{j-1} → q_{j-2}).
    let mut j = last_out;
    loop {
        lap(j, -dir, q[j], out);
        if j < 3 {
            break; // just finished ring 1 (or the chain is too short) — exit at p_1
        }
        push_pt(out, rs[j - 1].point_at(m[j - 1]));
        push_pt(out, rs[j - 2].point_at(q[j - 2]));
        j -= 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(rings: &[Vec<P>], spacing: f32) -> Vec<Stroke> {
        let mut out = Vec::new();
        fill(rings, spacing, &mut out);
        out
    }

    fn max_seg(s: &Stroke) -> f32 {
        s.points
            .windows(2)
            .map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y))
            .fold(0.0, f32::max)
    }

    fn is_closed(s: &Stroke) -> bool {
        let (f, l) = (s.points.first().unwrap(), s.points.last().unwrap());
        (f.x - l.x).hypot(f.y - l.y) < 0.5
    }

    /// Freehand blob with concave lobes (regression shape: seam and corridor must stay put at
    /// coarse spacing).
    fn blob() -> Vec<P> {
        (0..96)
            .map(|i| {
                let t = i as f32 / 96.0 * std::f32::consts::TAU;
                let r = 30.0 + 10.0 * (3.0 * t + 1.0).sin() + 5.0 * (7.0 * t + 2.0).sin();
                (50.0 + r * t.cos(), 50.0 + r * t.sin())
            })
            .collect()
    }

    /// The hand-drawn path from the Calm-Ember test document: at spacing 10 its seam once seeded
    /// on a hairpin tip and the deep link chorded across the shape.
    fn calm_ember() -> Vec<P> {
        vec![
            (6.2e+01, 7.6),
            (6.2e+01, 1.4e+01),
            (6.1e+01, 2e+01),
            (5.9e+01, 2.4e+01),
            (5.6e+01, 2.7e+01),
            (5.3e+01, 2.9e+01),
            (4.9e+01, 3.1e+01),
            (4.4e+01, 3.3e+01),
            (3.9e+01, 3.8e+01),
            (3.3e+01, 4.6e+01),
            (2.7e+01, 5.7e+01),
            (2.1e+01, 6.7e+01),
            (1.4e+01, 7.2e+01),
            (7.1, 7e+01),
            (0.12, 6.3e+01),
            (-6.9, 5.4e+01),
            (-1.4e+01, 4.9e+01),
            (-2.1e+01, 5e+01),
            (-2.7e+01, 5.5e+01),
            (-3.3e+01, 5.9e+01),
            (-3.9e+01, 6e+01),
            (-4.4e+01, 5.6e+01),
            (-4.9e+01, 4.7e+01),
            (-5.3e+01, 3.7e+01),
            (-5.6e+01, 2.7e+01),
            (-5.9e+01, 1.7e+01),
            (-6.1e+01, 8.2),
            (-6.2e+01, 0.012),
            (-6.2e+01, -7.4),
            (-6.2e+01, -1.4e+01),
            (-6.1e+01, -2e+01),
            (-5.9e+01, -2.4e+01),
            (-5.6e+01, -2.7e+01),
            (-5.3e+01, -2.9e+01),
            (-4.9e+01, -3.1e+01),
            (7.5, 2.5),
            (-3.9e+01, -3.8e+01),
            (-3.4e+01, -4.6e+01),
            (-2.7e+01, -5.7e+01),
            (-2.1e+01, -6.7e+01),
            (-1.4e+01, -7.2e+01),
            (-7.3, -7.1e+01),
            (-0.36, -6.3e+01),
            (6.6, -5.4e+01),
            (1.4e+01, -5e+01),
            (2e+01, -5e+01),
            (2.7e+01, -5.5e+01),
            (3.3e+01, -5.9e+01),
            (3.9e+01, -6e+01),
            (4.4e+01, -5.6e+01),
            (4.9e+01, -4.8e+01),
            (5.3e+01, -3.8e+01),
            (5.6e+01, -2.7e+01),
            (5.9e+01, -1.8e+01),
            (6.1e+01, -8.5),
            (6.2e+01, -0.29),
            (6.2e+01, 7.1),
        ]
    }

    #[test]
    fn square_is_one_closed_stroke_inset_by_spacing() {
        let sq: Vec<P> = vec![(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)];
        let out = run(&[sq], 3.0);
        assert_eq!(out.len(), 1, "expected one stroke, got {}", out.len());
        let s = &out[0];
        assert!(is_closed(s), "fermat fill should close into a loop");
        // Smoothing subdivides everything, so no output segment may jump.
        assert!(max_seg(s) < 1.6, "segment jump of {}mm", max_seg(s));
        for p in &s.points {
            assert!(
                p.x > 1.8 && p.x < 18.2 && p.y > 1.8 && p.y < 18.2,
                "point ({}, {}) outside the spacing inset",
                p.x,
                p.y
            );
        }
        assert!(
            s.points
                .iter()
                .any(|p| (p.x - 10.0).abs() < 3.5 && (p.y - 10.0).abs() < 3.5),
            "fill never reaches the centre"
        );
    }

    #[test]
    fn lobed_blob_is_one_stroke_at_coarse_spacings() {
        for sp in [2.0_f32, 6.0, 8.0, 10.0] {
            let out = run(&[blob()], sp);
            assert_eq!(out.len(), 1, "spacing {sp}: {} strokes", out.len());
            let ms = max_seg(&out[0]);
            assert!(ms < 3.0, "spacing {sp}: segment jump of {ms}mm");
        }
    }

    #[test]
    fn calm_ember_regression_stays_inside_and_connected() {
        let outline = calm_ember();
        let out = run(std::slice::from_ref(&outline), 10.0);
        assert_eq!(out.len(), 1, "expected one stroke, got {}", out.len());
        let s = &out[0];
        assert!(is_closed(s));
        assert!(max_seg(s) < 3.0, "segment jump of {}mm", max_seg(s));
        // The fill must not bleed outside the shape (and the deep link must not chord across).
        for p in &s.points {
            assert!(
                inside(&outline, p.x, p.y),
                "fill point ({}, {}) escaped the outline",
                p.x,
                p.y
            );
        }
    }

    #[test]
    fn annulus_fills_both_sides_and_leaves_the_hole_empty() {
        let outer: Vec<P> = vec![(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)];
        let hole: Vec<P> = vec![(16.0, 16.0), (24.0, 16.0), (24.0, 24.0), (16.0, 24.0)];
        let out = run(&[outer, hole], 2.0);
        assert!(
            (2..=5).contains(&out.len()),
            "expected a spiral per side (plus medial leftovers), got {}",
            out.len()
        );
        for s in &out {
            for p in &s.points {
                assert!(
                    !(p.x > 17.0 && p.x < 23.0 && p.y > 17.0 && p.y < 23.0),
                    "fill entered the hole at ({}, {})",
                    p.x,
                    p.y
                );
            }
        }
    }
}
