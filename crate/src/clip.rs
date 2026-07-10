//! Clip geometry to the reachable rectangle. Liang–Barsky per segment, splitting a stroke that
//! leaves and re-enters into separate strokes (pen/reversible/group preserved, so a clipped
//! locked chain stays an ordered chain). Pressure is interpolated at the cut points. The rect
//! itself is computed JS-side (it's view-adjacent); only the clipping runs here.

use crate::geom::{Point, Stroke};
use crate::poly::{crossings, inside_multi, P};

pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

fn lerp(a: &Point, b: &Point, t: f32) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
    }
}

/// The visible sub-range [t0, t1] of segment a→b inside the rect, or None.
fn clip_segment(a: &Point, b: &Point, r: &Rect) -> Option<(f32, f32)> {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let p = [-dx, dx, -dy, dy];
    let q = [a.x - r.x0, r.x1 - a.x, a.y - r.y0, r.y1 - a.y];
    let mut t0 = 0.0f32;
    let mut t1 = 1.0f32;
    for i in 0..4 {
        if p[i] == 0.0 {
            if q[i] < 0.0 {
                return None; // parallel and outside
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
    Some((t0, t1))
}

fn clip_stroke(s: &Stroke, r: &Rect, out: &mut Vec<Stroke>) {
    let pts = &s.points;
    if pts.is_empty() {
        return;
    }
    if pts.len() == 1 {
        let p = &pts[0];
        if p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1 {
            out.push(Stroke {
                points: pts.clone(),
                pen: s.pen,
                reversible: s.reversible,
                group: s.group,
            });
        }
        return;
    }

    let mut pieces: Vec<Vec<Point>> = Vec::new();
    let mut cur: Vec<Point> = Vec::new();
    for i in 0..pts.len() - 1 {
        let a = &pts[i];
        let b = &pts[i + 1];
        match clip_segment(a, b, r) {
            None => {
                if !cur.is_empty() {
                    pieces.push(std::mem::take(&mut cur));
                }
            }
            Some((t0, t1)) => {
                let q0 = if t0 == 0.0 { *a } else { lerp(a, b, t0) };
                let q1 = if t1 == 1.0 { *b } else { lerp(a, b, t1) };
                if cur.is_empty() {
                    cur.push(q0);
                } else if t0 > 0.0 {
                    // Re-entered after a gap. (When t0 == 0 the shared vertex is already the
                    // last point of `cur`, so it isn't duplicated.)
                    pieces.push(std::mem::take(&mut cur));
                    cur.push(q0);
                }
                cur.push(q1);
                if t1 < 1.0 {
                    pieces.push(std::mem::take(&mut cur));
                }
            }
        }
    }
    if !cur.is_empty() {
        pieces.push(cur);
    }

    for piece in pieces {
        if piece.len() >= 2 {
            out.push(Stroke {
                points: piece,
                pen: s.pen,
                reversible: s.reversible,
                group: s.group,
            });
        }
    }
}

pub fn clip(strokes: &[Stroke], r: &Rect) -> Vec<Stroke> {
    let mut out = Vec::new();
    for s in strokes {
        clip_stroke(s, r, &mut out);
    }
    out
}

/// Clip strokes to the even-odd interior of `rings` (an arbitrary mask polygon) — the polygon
/// counterpart of `clip` for clip-to-shape. Each stroke is split into the sub-polylines lying inside,
/// preserving pen/reversible/group (so a clipped locked chain stays a chain).
pub fn clip_to_polygon(strokes: &[Stroke], rings: &[Vec<P>]) -> Vec<Stroke> {
    if rings.iter().all(|r| r.len() < 3) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for s in strokes {
        clip_stroke_poly(s, rings, &mut out);
    }
    out
}

fn clip_stroke_poly(s: &Stroke, rings: &[Vec<P>], out: &mut Vec<Stroke>) {
    let pts = &s.points;
    if pts.len() < 2 {
        if pts.len() == 1 && inside_multi(rings, pts[0].x, pts[0].y) {
            out.push(Stroke {
                points: pts.clone(),
                pen: s.pen,
                reversible: s.reversible,
                group: s.group,
            });
        }
        return;
    }
    let flush = |run: &mut Vec<Point>, out: &mut Vec<Stroke>| {
        if run.len() >= 2 {
            out.push(Stroke {
                points: std::mem::take(run),
                pen: s.pen,
                reversible: s.reversible,
                group: s.group,
            });
        } else {
            run.clear();
        }
    };
    let mut run: Vec<Point> = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let mut bounds = vec![0.0f32];
        bounds.extend(crossings(rings, (a.x, a.y), (b.x, b.y)));
        bounds.push(1.0);
        for k in 0..bounds.len() - 1 {
            let (t0, t1) = (bounds[k], bounds[k + 1]);
            if t1 - t0 < 1e-9 {
                continue;
            }
            let mid = lerp(a, b, 0.5 * (t0 + t1));
            if inside_multi(rings, mid.x, mid.y) {
                let p0 = lerp(a, b, t0);
                let p1 = lerp(a, b, t1);
                let joins = run
                    .last()
                    .is_some_and(|q| (q.x - p0.x).abs() < 1e-6 && (q.y - p0.y).abs() < 1e-6);
                if !joins {
                    run.push(p0);
                }
                run.push(p1);
            } else {
                flush(&mut run, out);
            }
        }
    }
    flush(&mut run, out);
}

#[cfg(test)]
mod poly_tests {
    use super::*;
    fn p(x: f32, y: f32) -> Point {
        Point {
            x,
            y,
            pressure: 1.0,
        }
    }

    #[test]
    fn clips_to_square_preserving_metadata() {
        let s = Stroke {
            points: vec![p(-5.0, 5.0), p(15.0, 5.0)],
            pen: 3,
            reversible: false,
            group: 7,
        };
        let square: Vec<P> = vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let out = clip_to_polygon(&[s], &[square]);
        assert_eq!(out.len(), 1, "one inside span");
        let c = &out[0];
        assert_eq!(
            (c.pen, c.group, c.reversible),
            (3, 7, false),
            "metadata preserved"
        );
        let (lo, hi) = (c.points[0].x, c.points.last().unwrap().x);
        assert!(
            (lo - 0.0).abs() < 1e-3 && (hi - 10.0).abs() < 1e-3,
            "clipped to the square edges: {lo}..{hi}"
        );
    }

    #[test]
    fn even_odd_hole_splits_the_stroke() {
        let outer: Vec<P> = vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        let hole: Vec<P> = vec![(3.0, 3.0), (7.0, 3.0), (7.0, 7.0), (3.0, 7.0)];
        let s = Stroke {
            points: vec![p(-1.0, 5.0), p(11.0, 5.0)],
            pen: 0,
            reversible: true,
            group: 0,
        };
        let out = clip_to_polygon(&[s], &[outer, hole]);
        assert_eq!(
            out.len(),
            2,
            "the even-odd hole cuts the stroke into two spans"
        );
    }
}
