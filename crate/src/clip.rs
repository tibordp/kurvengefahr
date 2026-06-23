//! Clip geometry to the reachable rectangle. Liang–Barsky per segment, splitting a stroke that
//! leaves and re-enters into separate strokes (pen/reversible/group preserved, so a clipped
//! locked chain stays an ordered chain). Pressure is interpolated at the cut points. The rect
//! itself is computed JS-side (it's view-adjacent); only the clipping runs here.

use crate::geom::{Point, Stroke};

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
