//! Turtle state → strokes. Turtle math is **classic Logo**: y-up, heading 0 = north/up, `rt`
//! clockwise, direction vector `(sin h, cos h)`. Emission negates y into element-local page
//! space (y-down), so on screen `fd` goes up and `rt 90` turns right — what every Logo user
//! expects — while `setxy`/`ycor` keep textbook semantics.
//!
//! Strokes emit as free singletons (`reversible: true, group: 0`); whether they stay free is
//! decided at concatenation, where the element's `globalOptimize` param either locks them into
//! program order (the default — drawing order is often part of the composition) or leaves them
//! to per-pen travel optimization. Pen-up moves, `setpen` (a stroke has one pen), and the end of
//! the program flush the current polyline (kept if it has ≥ 2 points).
//!
//! The per-stroke `pen` from `setpen n` is the pen's id in the machine profile's palette (which
//! assigns ids 0, 1, 2 …). An id the palette doesn't have is tolerated downstream — default ink
//! colour on the canvas, plotted last — so the interpreter doesn't need to know the profile.

use crate::geom::{Point, Stroke};
use crate::tess::{ARC_MAX_SEGMENTS, ARC_STEP_RAD};

/// Exceeding an output limit aborts the run; the evaluator attaches the offending span.
#[derive(Debug)]
pub enum TurtleErr {
    TooManyPoints(usize),
    TooManyStrokes(usize),
}

pub struct Turtle {
    x: f64,
    y: f64,
    /// Degrees, 0 = up, clockwise positive.
    heading: f64,
    pen_down: bool,
    pressure: f64,
    /// Palette position (see module docs).
    pen: u16,
    cur: Vec<Point>,
    strokes: Vec<Stroke>,
    points_emitted: usize,
    max_points: usize,
    max_strokes: usize,
}

impl Turtle {
    pub fn new(max_points: usize, max_strokes: usize) -> Self {
        Turtle {
            x: 0.0,
            y: 0.0,
            heading: 0.0,
            pen_down: true,
            pressure: 1.0,
            pen: 0,
            cur: Vec::new(),
            strokes: Vec::new(),
            points_emitted: 0,
            max_points,
            max_strokes,
        }
    }

    pub fn xcor(&self) -> f64 {
        self.x
    }
    pub fn ycor(&self) -> f64 {
        self.y
    }
    pub fn heading(&self) -> f64 {
        self.heading
    }
    pub fn pressure(&self) -> f64 {
        self.pressure
    }
    pub fn pen(&self) -> u16 {
        self.pen
    }

    pub fn pen_up(&mut self) -> Result<(), TurtleErr> {
        self.flush()?;
        self.pen_down = false;
        Ok(())
    }
    pub fn pen_down(&mut self) {
        self.pen_down = true;
    }

    pub fn set_pressure(&mut self, p: f64) {
        self.pressure = p.clamp(0.0, 1.0);
    }

    pub fn set_pen(&mut self, n: u16) -> Result<(), TurtleErr> {
        if n != self.pen {
            self.flush()?;
            self.pen = n;
        }
        Ok(())
    }

    pub fn turn(&mut self, deg: f64) {
        self.heading = norm_deg(self.heading + deg);
    }
    pub fn set_heading(&mut self, deg: f64) {
        self.heading = norm_deg(deg);
    }

    /// Compass heading from the turtle to (x, y).
    pub fn towards(&self, x: f64, y: f64) -> f64 {
        norm_deg((x - self.x).atan2(y - self.y).to_degrees())
    }

    pub fn forward(&mut self, dist: f64) -> Result<(), TurtleErr> {
        let h = self.heading.to_radians();
        let (nx, ny) = (self.x + dist * h.sin(), self.y + dist * h.cos());
        self.line_to(nx, ny)
    }

    /// Straight move to (x, y), drawing if the pen is down.
    pub fn line_to(&mut self, x: f64, y: f64) -> Result<(), TurtleErr> {
        if self.pen_down {
            self.seed_stroke()?;
            self.push_point(x, y)?;
        } else {
            self.flush()?;
        }
        self.x = x;
        self.y = y;
        Ok(())
    }

    pub fn home(&mut self) -> Result<(), TurtleErr> {
        self.line_to(0.0, 0.0)?;
        self.heading = 0.0;
        Ok(())
    }

    /// UCB `arc`: an arc of `deg` degrees at `radius` around the turtle, starting at its heading,
    /// clockwise. Drawn as its own stroke (the pen isn't at the arc); the turtle doesn't move.
    pub fn arc(&mut self, deg: f64, radius: f64) -> Result<(), TurtleErr> {
        if !self.pen_down || deg == 0.0 || radius == 0.0 {
            return Ok(());
        }
        self.flush()?;
        let r = radius.abs();
        let n = arc_segments(deg);
        for i in 0..=n {
            let a = (self.heading + deg * i as f64 / n as f64).to_radians();
            let (px, py) = (self.x + r * a.sin(), self.y + r * a.cos());
            if i == 0 {
                self.cur.push(self.emit(px, py));
                self.points_emitted += 1;
            } else {
                self.push_point(px, py)?;
            }
        }
        self.flush()
    }

    /// Walk an arc of `deg` degrees along a circle of `radius`: positive `deg` curves right
    /// (center 90° to the turtle's right), negative curves left. The turtle ends on the arc,
    /// turned by `deg`; drawing continues the current stroke like `forward` does.
    pub fn arc2(&mut self, deg: f64, radius: f64) -> Result<(), TurtleErr> {
        if deg == 0.0 {
            return Ok(());
        }
        let r = radius.abs();
        if r == 0.0 {
            self.turn(deg);
            return Ok(());
        }
        // Center is 90° to the right for a right turn, 90° to the left for a left turn; the
        // compass angle from center to turtle then sweeps by `deg` either way.
        let side = if deg >= 0.0 { 90.0 } else { -90.0 };
        let ch = (self.heading + side).to_radians();
        let (cx, cy) = (self.x + r * ch.sin(), self.y + r * ch.cos());
        let theta0 = self.heading - side; // compass angle center → turtle
        let n = arc_segments(deg);
        for i in 1..=n {
            let a = (theta0 + deg * i as f64 / n as f64).to_radians();
            let (px, py) = (cx + r * a.sin(), cy + r * a.cos());
            if self.pen_down {
                self.seed_stroke()?;
                self.push_point(px, py)?;
            }
            self.x = px;
            self.y = py;
        }
        self.turn(deg);
        Ok(())
    }

    /// Finish: flush the open polyline and hand the strokes over.
    pub fn into_strokes(mut self) -> Result<Vec<Stroke>, TurtleErr> {
        self.flush()?;
        Ok(self.strokes)
    }

    // ── internals ───────────────────────────────────────────────────────────────────────────────

    /// Turtle space (y-up) → element-local page space (y-down), with the current pressure.
    fn emit(&self, x: f64, y: f64) -> Point {
        Point { x: x as f32, y: -y as f32, pressure: self.pressure as f32 }
    }

    /// Make sure the current polyline starts at the turtle's position.
    fn seed_stroke(&mut self) -> Result<(), TurtleErr> {
        if self.cur.is_empty() {
            self.check_points(1)?;
            self.cur.push(self.emit(self.x, self.y));
            self.points_emitted += 1;
        }
        Ok(())
    }

    fn push_point(&mut self, x: f64, y: f64) -> Result<(), TurtleErr> {
        let p = self.emit(x, y);
        // Zero-length segments (fd 0 in a loop) add nothing but budget; but a pressure change on
        // the spot is meaningful for the next real segment, so just skip exact duplicates.
        if let Some(last) = self.cur.last() {
            if last.x == p.x && last.y == p.y && last.pressure == p.pressure {
                return Ok(());
            }
        }
        self.check_points(1)?;
        self.cur.push(p);
        self.points_emitted += 1;
        Ok(())
    }

    fn check_points(&self, add: usize) -> Result<(), TurtleErr> {
        if self.points_emitted + add > self.max_points {
            Err(TurtleErr::TooManyPoints(self.max_points))
        } else {
            Ok(())
        }
    }

    fn flush(&mut self) -> Result<(), TurtleErr> {
        if self.cur.len() >= 2 {
            if self.strokes.len() >= self.max_strokes {
                return Err(TurtleErr::TooManyStrokes(self.max_strokes));
            }
            self.strokes.push(Stroke {
                points: std::mem::take(&mut self.cur),
                pen: self.pen,
                reversible: true,
                group: 0,
            });
        } else {
            self.cur.clear();
        }
        Ok(())
    }
}

fn norm_deg(d: f64) -> f64 {
    let m = d % 360.0;
    if m < 0.0 {
        m + 360.0
    } else {
        m
    }
}

/// Flattening resolution for arcs, from the shared tess constants.
fn arc_segments(deg: f64) -> usize {
    ((deg.abs().to_radians() / ARC_STEP_RAD).ceil() as usize).clamp(1, ARC_MAX_SEGMENTS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xy(s: &Stroke) -> Vec<(f32, f32)> {
        s.points.iter().map(|p| (p.x, p.y)).collect()
    }

    #[test]
    fn square_with_y_flip() {
        // fd 10 rt 90 fd 10 → up then right on screen: page y decreases going "up".
        let mut t = Turtle::new(1000, 100);
        t.forward(10.0).unwrap();
        t.turn(90.0);
        t.forward(10.0).unwrap();
        let s = t.into_strokes().unwrap();
        assert_eq!(s.len(), 1);
        let pts = xy(&s[0]);
        assert_eq!(pts.len(), 3);
        assert!((pts[1].0 - 0.0).abs() < 1e-4 && (pts[1].1 - -10.0).abs() < 1e-4, "fd goes up (page -y): {:?}", pts);
        assert!((pts[2].0 - 10.0).abs() < 1e-4 && (pts[2].1 - -10.0).abs() < 1e-4, "rt 90 then fd goes right: {:?}", pts);
    }

    #[test]
    fn penup_gaps_split_strokes() {
        let mut t = Turtle::new(1000, 100);
        t.forward(5.0).unwrap();
        t.pen_up().unwrap();
        t.forward(5.0).unwrap();
        t.pen_down();
        t.forward(5.0).unwrap();
        let s = t.into_strokes().unwrap();
        assert_eq!(s.len(), 2);
        // Second stroke starts where the pen went down, not at the origin.
        assert!((s[1].points[0].y - -10.0).abs() < 1e-4);
    }

    #[test]
    fn pressure_is_stamped_per_point() {
        let mut t = Turtle::new(1000, 100);
        t.set_pressure(0.2);
        t.forward(5.0).unwrap();
        t.set_pressure(0.9);
        t.forward(5.0).unwrap();
        let s = t.into_strokes().unwrap();
        let ps: Vec<f32> = s[0].points.iter().map(|p| p.pressure).collect();
        assert_eq!(ps, vec![0.2, 0.2, 0.9]);
    }

    #[test]
    fn setpen_flushes_and_stamps() {
        let mut t = Turtle::new(1000, 100);
        t.forward(5.0).unwrap();
        t.set_pen(2).unwrap();
        t.forward(5.0).unwrap();
        let s = t.into_strokes().unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].pen, 0);
        assert_eq!(s[1].pen, 2);
    }

    #[test]
    fn arc_point_count_follows_tess_step() {
        let mut t = Turtle::new(100000, 100);
        t.arc(360.0, 10.0).unwrap();
        // Turtle didn't move.
        assert_eq!((t.xcor(), t.ycor(), t.heading()), (0.0, 0.0, 0.0));
        let s = t.into_strokes().unwrap();
        assert_eq!(s.len(), 1);
        // 2π / (π/32) = 64 segments → 65 points.
        assert_eq!(s[0].points.len(), 65);
    }

    #[test]
    fn arc2_walks_and_turns() {
        // 90° right turn along radius 10: ends at (10, 10) turtle space = (10, -10) page space,
        // heading 90.
        let mut t = Turtle::new(100000, 100);
        t.arc2(90.0, 10.0).unwrap();
        assert!((t.xcor() - 10.0).abs() < 1e-6, "x {}", t.xcor());
        assert!((t.ycor() - 10.0).abs() < 1e-6, "y {}", t.ycor());
        assert!((t.heading() - 90.0).abs() < 1e-6);
        // Left turn mirrors.
        let mut t = Turtle::new(100000, 100);
        t.arc2(-90.0, 10.0).unwrap();
        assert!((t.xcor() - -10.0).abs() < 1e-6);
        assert!((t.ycor() - 10.0).abs() < 1e-6);
        assert!((t.heading() - 270.0).abs() < 1e-6);
    }

    #[test]
    fn point_limit_fires() {
        let mut t = Turtle::new(10, 100);
        let mut hit = false;
        for _ in 0..20 {
            t.turn(10.0);
            if t.forward(5.0).is_err() {
                hit = true;
                break;
            }
        }
        assert!(hit, "point limit should fire");
    }

    #[test]
    fn towards_compass() {
        let t = Turtle::new(10, 10);
        assert!((t.towards(0.0, 5.0) - 0.0).abs() < 1e-6); // straight up
        assert!((t.towards(5.0, 0.0) - 90.0).abs() < 1e-6); // right
        assert!((t.towards(0.0, -5.0) - 180.0).abs() < 1e-6);
        assert!((t.towards(-5.0, 0.0) - 270.0).abs() < 1e-6);
    }
}
