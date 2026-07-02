//! Taper — calligraphic pen-lift: fade each open stroke's per-point pressure toward its ends, so a
//! stroke lands and leaves light (a min-pressure tip ramping up to full over the first/last few mm).
//! Pure pressure modulation — geometry is untouched except that a taper zone is densified so the
//! ramp has points to ride (long straight segments would otherwise only carry the two endpoints).
//! A gain on the existing per-point pressure, so it composes with variable-pressure ink. Closed
//! contours have no free ends, so they're left alone (a seam dip would look wrong).
use super::{is_closed, EffectSpec};
use crate::geom::{Point, Stroke};

/// Cumulative arc length at each point, plus the total.
fn arclen(pts: &[Point]) -> (Vec<f32>, f32) {
    let mut acc = Vec::with_capacity(pts.len());
    let mut s = 0.0f32;
    for i in 0..pts.len() {
        if i > 0 {
            s += (pts[i].x - pts[i - 1].x).hypot(pts[i].y - pts[i - 1].y);
        }
        acc.push(s);
    }
    (acc, s)
}

pub fn apply(strokes: &[Stroke], s: &EffectSpec) -> Vec<Stroke> {
    let start = s.start_mm.max(0.0);
    let end = s.end_mm.max(0.0);
    if start <= 1e-4 && end <= 1e-4 {
        return strokes.to_vec();
    }
    let min_p = s.min_pressure.clamp(0.0, 1.0);
    const STEP: f32 = 0.6; // ramp resolution inside a taper zone, mm

    strokes
        .iter()
        .map(|stroke| {
            if stroke.points.len() < 2 || is_closed(&stroke.points) {
                return stroke.clone();
            }
            let (_, total) = arclen(&stroke.points);
            if total <= 1e-4 {
                return stroke.clone();
            }

            // Densify, but only within the head/tail taper zones — the untapered middle of a long
            // stroke keeps its original (sparse) sampling.
            let mut pts: Vec<Point> = Vec::with_capacity(stroke.points.len());
            let mut cum = 0.0f32;
            for i in 0..stroke.points.len() {
                let p = stroke.points[i];
                if i == 0 {
                    pts.push(p);
                    continue;
                }
                let a = stroke.points[i - 1];
                let seg = (p.x - a.x).hypot(p.y - a.y);
                let (s0, s1) = (cum, cum + seg);
                let in_zone = s0 < start || s1 > total - end;
                if in_zone && seg > STEP {
                    let n = (seg / STEP).ceil() as usize;
                    for k in 1..n {
                        let t = k as f32 / n as f32;
                        pts.push(Point {
                            x: a.x + (p.x - a.x) * t,
                            y: a.y + (p.y - a.y) * t,
                            pressure: a.pressure + (p.pressure - a.pressure) * t,
                        });
                    }
                }
                pts.push(p);
                cum = s1;
            }

            // Ramp min_p → 1 over `start` from the head and over `end` toward the tail; the smaller
            // of the two wins (near a tip), and it multiplies the existing pressure.
            let (acc, len) = arclen(&pts);
            let ramp = |d: f32, w: f32| if w <= 1e-4 { 1.0 } else { (d / w).clamp(0.0, 1.0) };
            let out = pts
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let d = acc[i];
                    let f = (min_p + (1.0 - min_p) * ramp(d, start))
                        .min(min_p + (1.0 - min_p) * ramp(len - d, end));
                    Point { x: p.x, y: p.y, pressure: p.pressure * f }
                })
                .collect();
            Stroke { points: out, pen: stroke.pen, reversible: stroke.reversible, group: stroke.group }
        })
        .collect()
}
