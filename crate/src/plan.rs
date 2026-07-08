//! AxiDraw (EBB) motion planner: optimized page-space strokes → a flat tape of timed, quantized
//! motion segments plus pen/pause events, ready to stream over Web Serial as `LM`/`SM` commands.
//!
//! This is the AxiDraw analog of the TS `emit` stage. Page mm *is* machine mm here (the machine is
//! top-left-origin with no pen offset), so no coordinate transform crosses the boundary. The
//! planning itself is saxi-style constant-acceleration motion:
//!
//!   * per polyline (a pen-down stroke, or a 2-point pen-up travel): junction-deviation cornering
//!     limits at interior vertices, forward/backward passes to make every vertex velocity
//!     reachable, then a trapezoidal (accel / cruise / decel) profile per segment;
//!   * every polyline starts and ends at rest (pen lifts separate them), so cornering never spans
//!     a pen state change;
//!   * vertices are additionally clamped to v=0 wherever a block would exceed
//!     `max_block_seconds` — those rest points are the only safe places the streaming loop may
//!     pause, which bounds pause latency on huge strokes;
//!   * step quantization rounds the *cumulative* motor position, never per-segment deltas, so
//!     total drift is < 1 step by construction (EBB motor axes: m1 = x + y, m2 = x − y);
//!   * `LM` rate/accel terms use the EBB's 25 kHz / 2³¹-accumulator model:
//!     `rate = steps_per_sec · 2³¹ / 25000`, `delta = Δrate / ticks` (direction rides on the sign
//!     of the step counts, so rates are non-negative).

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::geom::Stroke;

/// Segment kinds in the plan tape (mirrored by `src/core/pipeline/plan.ts`).
pub const KIND_MOTION: u8 = 0;
pub const KIND_PEN_DOWN: u8 = 1;
pub const KIND_PEN_UP: u8 = 2;
pub const KIND_PAUSE_FIDUCIAL: u8 = 3;
pub const KIND_PAUSE_PENSWAP: u8 = 4;

/// EBB motion tick rate (Hz); the step accumulator threshold is 2³¹ (see the `LM` reference).
const TICK_HZ: f64 = 25_000.0;
/// LM rate units per (step/sec): rate = v_steps · 2³¹ / 25000.
const RATE_PER_STEP_HZ: f64 = 2_147_483_648.0 / TICK_HZ;

/// Segments shorter than this (mm) are collapsed at planning time.
const EPS_LEN: f64 = 1e-6;
/// Phases shorter than this (s) are dropped — well under one 40 µs tick.
const EPS_TIME: f64 = 1e-6;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanParams {
    /// Steps per mm in the X/Y frame (80 at the AxiDraw's native 16× microstepping, `EM,1,1`).
    pub steps_per_mm: f64,
    /// Path speeds, mm/s.
    pub draw_speed: f64,
    pub travel_speed: f64,
    /// mm/s².
    pub acceleration: f64,
    /// Junction deviation, mm (0 = full stop at every vertex).
    pub cornering: f64,
    /// Servo lift/drop times, ms — the durations of pen_up / pen_down segments.
    pub lift_ms: f64,
    pub drop_ms: f64,
    /// Pen park (= machine home) in page mm; the tape starts and ends here.
    pub start: [f64; 2],
    #[serde(default)]
    pub fiducial: Option<[f64; 2]>,
    /// Max seconds between rest points inside a polyline (forced pause boundaries).
    pub max_block_seconds: f64,
}

/// One tape entry. Motion segments carry quantized steps + LM terms; pen/pause segments carry only
/// timing/metadata. `dist` is the *cumulative preview distance* at the segment's end, matching
/// `buildToolpath`'s travel+draw parameterization exactly (the live-playhead contract); the final
/// return-home travel doesn't advance it (the preview path ends at the last stroke).
pub struct Segment {
    pub kind: u8,
    pub steps: [i32; 2],
    pub rate: [i32; 2],
    pub delta: [i32; 2],
    pub duration_ms: f64,
    pub dist: f64,
    pub pos: [f64; 2],
    pub pen: u16,
    /// True when the machine is at rest at the *start* of this segment — a safe pause point.
    pub block_start: bool,
}

/// Junction-deviation cornering limit between unit directions `d_in` and `d_out` (Grbl/saxi
/// formula): the speed at which the path may round the corner by at most `deviation` mm under
/// acceleration `a`. Collinear → `vmax`; reversal → 0.
fn corner_velocity(d_in: [f64; 2], d_out: [f64; 2], vmax: f64, a: f64, deviation: f64) -> f64 {
    let cosine = -(d_in[0] * d_out[0] + d_in[1] * d_out[1]);
    if (cosine - 1.0).abs() < 1e-9 {
        return 0.0; // full reversal
    }
    let sine = ((1.0 - cosine) / 2.0).sqrt();
    if (sine - 1.0).abs() < 1e-9 {
        return vmax; // straight through
    }
    (a * deviation * sine / (1.0 - sine)).sqrt().min(vmax)
}

/// Time to traverse a segment of length `l` from `v_in` to `v_out` under the trapezoidal profile
/// (accelerate toward `vmax`, cruise, decelerate). Assumes the pair is reachable (post-passes).
fn segment_duration(l: f64, v_in: f64, v_out: f64, vmax: f64, a: f64) -> f64 {
    let d_acc = ((vmax * vmax - v_in * v_in) / (2.0 * a)).max(0.0);
    let d_dec = ((vmax * vmax - v_out * v_out) / (2.0 * a)).max(0.0);
    if d_acc + d_dec <= l {
        (vmax - v_in) / a + (l - d_acc - d_dec) / vmax + (vmax - v_out) / a
    } else {
        let vp = ((2.0 * a * l + v_in * v_in + v_out * v_out) / 2.0).sqrt().max(v_in.max(v_out));
        (vp - v_in) / a + (vp - v_out) / a
    }
}

struct Planner<'a> {
    p: &'a PlanParams,
    segs: Vec<Segment>,
    /// Steps actually emitted so far, per motor axis (the quantization anchor).
    emitted: [i64; 2],
    /// Pen position, mm.
    pos: [f64; 2],
    /// Cumulative preview distance, mm.
    dist: f64,
    pen: u16,
    /// The machine is at rest (v = 0) at the current tape position.
    at_rest: bool,
}

impl<'a> Planner<'a> {
    fn new(p: &'a PlanParams) -> Self {
        let m = motor_pos(p.steps_per_mm, p.start);
        Planner {
            p,
            segs: Vec::new(),
            emitted: [m[0].round() as i64, m[1].round() as i64],
            pos: p.start,
            dist: 0.0,
            pen: 0,
            at_rest: true,
        }
    }

    fn push_event(&mut self, kind: u8, duration_ms: f64, pen: u16) {
        self.segs.push(Segment {
            kind,
            steps: [0, 0],
            rate: [0, 0],
            delta: [0, 0],
            duration_ms,
            dist: self.dist,
            pos: self.pos,
            pen,
            block_start: true, // pen/pause events only occur at rest
        });
        self.at_rest = true;
    }

    /// One constant-acceleration phase: a straight move to `target` (mm) over `t` seconds, path
    /// speed `v_in` → `v_out`. Quantizes the cumulative motor position and emits LM terms; a phase
    /// that rounds to zero steps on both axes is skipped without sending time to the machine (its
    /// sub-step remainder is picked up by a later phase).
    fn push_motion(&mut self, target: [f64; 2], v_in: f64, v_out: f64, t: f64, counts_dist: bool) {
        let from = self.pos;
        let l = ((target[0] - from[0]).powi(2) + (target[1] - from[1]).powi(2)).sqrt();
        if counts_dist {
            self.dist += l;
        }
        let m = motor_pos(self.p.steps_per_mm, target);
        let steps = [
            (m[0].round() as i64 - self.emitted[0]) as i32,
            (m[1].round() as i64 - self.emitted[1]) as i32,
        ];
        self.pos = target;
        let resting_after = v_out <= 1e-9;
        if (steps[0] == 0 && steps[1] == 0) || t < EPS_TIME || l < EPS_LEN {
            // Nothing is sent, so the machine's physical state is unchanged; it is at rest after
            // this "phase" only if it already was, or the plan says velocity reaches zero here.
            self.at_rest = self.at_rest || resting_after;
            return;
        }
        self.emitted[0] += steps[0] as i64;
        self.emitted[1] += steps[1] as i64;

        // Per-motor-axis speeds (steps/s): project the path speed onto the mixed axes. Direction
        // rides on the sign of `steps`, so LM rates are magnitudes.
        let dir = [(target[0] - from[0]) / l, (target[1] - from[1]) / l];
        let axis_scale = [
            (dir[0] + dir[1]) * self.p.steps_per_mm,
            (dir[0] - dir[1]) * self.p.steps_per_mm,
        ];
        let ticks = t * TICK_HZ;
        let mut rate = [0i32; 2];
        let mut delta = [0i32; 2];
        for ax in 0..2 {
            if steps[ax] == 0 {
                continue; // idle axis: rate/delta stay 0 (per the LM reference)
            }
            let r_in = (v_in * axis_scale[ax]).abs() * RATE_PER_STEP_HZ;
            let r_out = (v_out * axis_scale[ax]).abs() * RATE_PER_STEP_HZ;
            rate[ax] = r_in.round() as i32;
            delta[ax] = ((r_out - r_in) / ticks).round() as i32;
        }
        self.segs.push(Segment {
            kind: KIND_MOTION,
            steps,
            rate,
            delta,
            duration_ms: t * 1000.0,
            dist: self.dist,
            pos: target,
            pen: self.pen,
            block_start: self.at_rest,
        });
        self.at_rest = resting_after;
    }

    /// Plan one polyline (starting at the current position) at path speed limit `vmax`, starting
    /// and ending at rest, and emit its motion phases.
    fn plan_polyline(&mut self, pts: &[[f64; 2]], vmax: f64, counts_dist: bool) {
        let (a, deviation, max_block) =
            (self.p.acceleration, self.p.cornering, self.p.max_block_seconds);

        // Cleaned vertex/segment lists (near-zero segments collapsed). Long segments are
        // subdivided so the forced-rest pre-pass below always has a vertex within the pause
        // budget — a single 2 m line must still be pausable (interior vertices are collinear, so
        // subdivision costs nothing unless a clamp lands on one).
        let max_piece = (vmax * max_block).max(EPS_LEN);
        let mut verts: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
        let mut dirs: Vec<[f64; 2]> = Vec::new();
        let mut lens: Vec<f64> = Vec::new();
        for &pt in pts {
            let Some(&prev) = verts.last() else {
                verts.push(pt);
                continue;
            };
            let l = ((pt[0] - prev[0]).powi(2) + (pt[1] - prev[1]).powi(2)).sqrt();
            if l < EPS_LEN {
                continue;
            }
            let dir = [(pt[0] - prev[0]) / l, (pt[1] - prev[1]) / l];
            let pieces = (l / max_piece).ceil().max(1.0) as usize;
            for k in 1..=pieces {
                let end = if k == pieces {
                    pt
                } else {
                    let along = l * k as f64 / pieces as f64;
                    [prev[0] + dir[0] * along, prev[1] + dir[1] * along]
                };
                let last = *verts.last().unwrap();
                dirs.push(dir);
                lens.push(((end[0] - last[0]).powi(2) + (end[1] - last[1]).powi(2)).sqrt());
                verts.push(end);
            }
        }
        let n = lens.len();
        if n == 0 {
            return;
        }

        // Vertex velocity limits: rest at both ends, cornering limits between segments.
        let mut v = vec![0.0f64; n + 1];
        for i in 1..n {
            v[i] = corner_velocity(dirs[i - 1], dirs[i], vmax, a, deviation);
        }
        let (fwd, bwd) = (0..n, (0..n).rev());
        for i in fwd.clone() {
            v[i + 1] = v[i + 1].min((v[i] * v[i] + 2.0 * a * lens[i]).sqrt());
        }
        for i in bwd.clone() {
            v[i] = v[i].min((v[i + 1] * v[i + 1] + 2.0 * a * lens[i]).sqrt());
        }

        // Forced rest points: clamp a vertex to v=0 whenever the running block time exceeds the
        // budget, so the streaming loop is never more than ~max_block from a safe pause. The walk
        // uses pre-clamp durations (clamping only slows things down — close enough), then the
        // passes re-run to keep every velocity reachable (zeros survive `min`).
        let mut clamped = false;
        let mut acc = 0.0;
        for i in 0..n {
            acc += segment_duration(lens[i], v[i], v[i + 1], vmax, a);
            if acc > max_block && i + 1 < n {
                v[i + 1] = 0.0;
                clamped = true;
                acc = 0.0;
            }
        }
        if clamped {
            for i in fwd {
                v[i + 1] = v[i + 1].min((v[i] * v[i] + 2.0 * a * lens[i]).sqrt());
            }
            for i in bwd {
                v[i] = v[i].min((v[i + 1] * v[i + 1] + 2.0 * a * lens[i]).sqrt());
            }
        }

        // Trapezoid per segment → 1–3 constant-acceleration phases.
        for i in 0..n {
            let (v_in, v_out, l) = (v[i], v[i + 1], lens[i]);
            let d_acc = ((vmax * vmax - v_in * v_in) / (2.0 * a)).max(0.0);
            let d_dec = ((vmax * vmax - v_out * v_out) / (2.0 * a)).max(0.0);
            // (length, v at phase start, v at phase end)
            let phases: [(f64, f64, f64); 3] = if d_acc + d_dec <= l {
                [(d_acc, v_in, vmax), (l - d_acc - d_dec, vmax, vmax), (d_dec, vmax, v_out)]
            } else {
                let vp = ((2.0 * a * l + v_in * v_in + v_out * v_out) / 2.0)
                    .sqrt()
                    .max(v_in.max(v_out));
                let up = ((vp * vp - v_in * v_in) / (2.0 * a)).max(0.0);
                [(up, v_in, vp), ((l - up).max(0.0), vp, v_out), (0.0, v_out, v_out)]
            };
            let live: Vec<&(f64, f64, f64)> = phases.iter().filter(|p| p.0 > EPS_LEN).collect();
            let mut along = 0.0;
            for (k, &&(pl, pvi, pvo)) in live.iter().enumerate() {
                along += pl;
                // Land the segment's last phase exactly on the vertex (no float creep).
                let target = if k == live.len() - 1 {
                    verts[i + 1]
                } else {
                    [verts[i][0] + dirs[i][0] * along, verts[i][1] + dirs[i][1] * along]
                };
                if pvi + pvo <= 1e-9 {
                    continue;
                }
                self.push_motion(target, pvi, pvo, 2.0 * pl / (pvi + pvo), counts_dist);
            }
            // A fully-degenerate segment (all phases sub-EPS) still has to land on the vertex.
            if live.is_empty() {
                self.push_motion(verts[i + 1], v_in.max(v_out).max(1e-3), v_out, EPS_TIME, counts_dist);
            }
        }
    }
}

fn motor_pos(steps_per_mm: f64, mm: [f64; 2]) -> [f64; 2] {
    [(mm[0] + mm[1]) * steps_per_mm, (mm[0] - mm[1]) * steps_per_mm]
}

/// Plan the whole job. Input strokes are already optimized (pens contiguous, palette order). The
/// tape: pen up → (fiducial travel + pause)? → per stroke: (pen-swap pause)? travel, pen down,
/// draw, pen up → travel home. Empty geometry → empty tape.
pub fn plan(strokes: &[Stroke], p: &PlanParams) -> Vec<Segment> {
    let mut pl = Planner::new(p);
    let Some(first_pen) = strokes.iter().find(|s| !s.points.is_empty()).map(|s| s.pen) else {
        return pl.segs;
    };
    pl.pen = first_pen;
    pl.push_event(KIND_PEN_UP, p.lift_ms, first_pen);
    if let Some(f) = p.fiducial {
        let from = pl.pos;
        pl.plan_polyline(&[from, f], p.travel_speed, true);
        pl.push_event(KIND_PAUSE_FIDUCIAL, 0.0, first_pen);
    }
    for s in strokes {
        if s.points.is_empty() {
            continue;
        }
        if s.pen != pl.pen {
            pl.pen = s.pen;
            pl.push_event(KIND_PAUSE_PENSWAP, 0.0, s.pen);
        }
        let head = [s.points[0].x as f64, s.points[0].y as f64];
        let from = pl.pos;
        pl.plan_polyline(&[from, head], p.travel_speed, true);
        pl.push_event(KIND_PEN_DOWN, p.drop_ms, pl.pen);
        let pts: Vec<[f64; 2]> = s.points.iter().map(|pt| [pt.x as f64, pt.y as f64]).collect();
        pl.plan_polyline(&pts, p.draw_speed, true);
        pl.push_event(KIND_PEN_UP, p.lift_ms, pl.pen);
    }
    // Return home so the job ends where the operator parked the carriage. Off the preview path
    // (dist stays at the toolpath total — the playhead rests at the last stroke).
    let from = pl.pos;
    pl.plan_polyline(&[from, p.start], p.travel_speed, false);
    pl.segs
}

/// Flat plan returned to JS (mirrors `PlotPlan` in `src/core/pipeline/plan.ts`). Parallel arrays,
/// one entry per segment; each getter hands back a fresh typed array (a copy).
#[wasm_bindgen]
pub struct PlanBuffers {
    kind: Vec<u8>,
    steps1: Vec<i32>,
    steps2: Vec<i32>,
    rate1: Vec<i32>,
    rate2: Vec<i32>,
    delta1: Vec<i32>,
    delta2: Vec<i32>,
    duration_ms: Vec<f32>,
    dist: Vec<f32>,
    x: Vec<f32>,
    y: Vec<f32>,
    pen: Vec<u16>,
    block_start: Vec<u8>,
    total_duration_ms: f64,
    total_dist: f64,
}

#[wasm_bindgen]
impl PlanBuffers {
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> Vec<u8> {
        self.kind.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn steps1(&self) -> Vec<i32> {
        self.steps1.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn steps2(&self) -> Vec<i32> {
        self.steps2.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn rate1(&self) -> Vec<i32> {
        self.rate1.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn rate2(&self) -> Vec<i32> {
        self.rate2.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn delta1(&self) -> Vec<i32> {
        self.delta1.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn delta2(&self) -> Vec<i32> {
        self.delta2.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn duration_ms(&self) -> Vec<f32> {
        self.duration_ms.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn dist(&self) -> Vec<f32> {
        self.dist.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> Vec<f32> {
        self.x.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> Vec<f32> {
        self.y.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn pen(&self) -> Vec<u16> {
        self.pen.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn block_start(&self) -> Vec<u8> {
        self.block_start.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn total_duration_ms(&self) -> f64 {
        self.total_duration_ms
    }
    #[wasm_bindgen(getter)]
    pub fn total_dist(&self) -> f64 {
        self.total_dist
    }
}

impl PlanBuffers {
    pub fn from_segments(segs: &[Segment]) -> Self {
        let n = segs.len();
        let mut b = PlanBuffers {
            kind: Vec::with_capacity(n),
            steps1: Vec::with_capacity(n),
            steps2: Vec::with_capacity(n),
            rate1: Vec::with_capacity(n),
            rate2: Vec::with_capacity(n),
            delta1: Vec::with_capacity(n),
            delta2: Vec::with_capacity(n),
            duration_ms: Vec::with_capacity(n),
            dist: Vec::with_capacity(n),
            x: Vec::with_capacity(n),
            y: Vec::with_capacity(n),
            pen: Vec::with_capacity(n),
            block_start: Vec::with_capacity(n),
            total_duration_ms: 0.0,
            total_dist: 0.0,
        };
        for s in segs {
            b.kind.push(s.kind);
            b.steps1.push(s.steps[0]);
            b.steps2.push(s.steps[1]);
            b.rate1.push(s.rate[0]);
            b.rate2.push(s.rate[1]);
            b.delta1.push(s.delta[0]);
            b.delta2.push(s.delta[1]);
            b.duration_ms.push(s.duration_ms as f32);
            b.dist.push(s.dist as f32);
            b.x.push(s.pos[0] as f32);
            b.y.push(s.pos[1] as f32);
            b.pen.push(s.pen);
            b.block_start.push(s.block_start as u8);
            b.total_duration_ms += s.duration_ms;
        }
        b.total_dist = segs.last().map_or(0.0, |s| s.dist);
        b
    }
}

pub fn plan_from_json(strokes: &[Stroke], params: &str) -> PlanBuffers {
    let p: PlanParams = match serde_json::from_str(params) {
        Ok(p) => p,
        Err(_) => return PlanBuffers::from_segments(&[]),
    };
    PlanBuffers::from_segments(&plan(strokes, &p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::Point;

    fn params() -> PlanParams {
        PlanParams {
            steps_per_mm: 80.0,
            draw_speed: 25.0,
            travel_speed: 100.0,
            acceleration: 1000.0,
            cornering: 0.127,
            lift_ms: 180.0,
            drop_ms: 180.0,
            start: [0.0, 0.0],
            fiducial: None,
            max_block_seconds: 5.0,
        }
    }

    fn stroke(pen: u16, pts: &[[f64; 2]]) -> Stroke {
        Stroke {
            points: pts
                .iter()
                .map(|p| Point { x: p[0] as f32, y: p[1] as f32, pressure: 1.0 })
                .collect(),
            pen,
            reversible: true,
            group: 0,
        }
    }

    /// Sum of emitted steps over the whole tape lands exactly on the rounded final motor position.
    fn assert_quantization(segs: &[Segment], p: &PlanParams, end_mm: [f64; 2]) {
        let m0 = motor_pos(p.steps_per_mm, p.start);
        let m1 = motor_pos(p.steps_per_mm, end_mm);
        for ax in 0..2 {
            let total: i64 = segs.iter().map(|s| s.steps[ax] as i64).sum();
            let expect = m1[ax].round() as i64 - m0[ax].round() as i64;
            assert!(
                (total - expect).abs() <= 1,
                "axis {ax}: emitted {total} steps, exact end is {expect}"
            );
        }
    }

    #[test]
    fn trapezoid_phases_and_duration() {
        // 100 mm straight line at vmax 25, a 1000: 0.3125 mm accel + decel ramps, cruise between.
        // t = 2·(25/1000) + (100 − 0.625)/25 = 0.05 + 3.975 = 4.025 s of drawing.
        let p = params();
        let segs = plan(&[stroke(0, &[[0.0, 10.0], [100.0, 10.0]])], &p);
        // Draw phases sit between the pen_down and the following pen_up on the tape.
        let di = segs.iter().position(|s| s.kind == KIND_PEN_DOWN).unwrap();
        let ui = segs.iter().skip(di).position(|s| s.kind == KIND_PEN_UP).unwrap() + di;
        let draw: Vec<&Segment> = segs[di + 1..ui].iter().collect();
        let draw_ms: f64 = draw.iter().map(|s| s.duration_ms).sum();
        assert!((draw_ms - 4025.0).abs() < 5.0, "draw time {draw_ms} ms, expected ≈4025");
        assert_eq!(draw.len(), 3, "accel + cruise + decel");
        // Cruise phase: constant velocity → delta 0, rate = 25 mm/s · 80 steps/mm · 2³¹/25000
        // on motor axis 1 (pure +X: both axes see the same speed).
        let cruise = draw[1];
        assert_eq!(cruise.delta, [0, 0]);
        let expect = (25.0 * 80.0 * RATE_PER_STEP_HZ).round() as i32;
        assert_eq!(cruise.rate[0], expect);
        assert_eq!(cruise.rate[1], expect);
        assert_quantization(&segs, &p, p.start);
    }

    #[test]
    fn corner_velocity_golds() {
        let a = 1000.0;
        let d = 0.127;
        // Collinear: straight through at vmax.
        assert_eq!(corner_velocity([1.0, 0.0], [1.0, 0.0], 50.0, a, d), 50.0);
        // Reversal: full stop.
        assert_eq!(corner_velocity([1.0, 0.0], [-1.0, 0.0], 50.0, a, d), 0.0);
        // 90°: sin(θ/2) = √½ → v = √(a·δ·s/(1−s)) = √(1000·0.127·2.4142…) ≈ 17.512.
        let v = corner_velocity([1.0, 0.0], [0.0, 1.0], 50.0, a, d);
        assert!((v - 17.512).abs() < 0.01, "90° corner velocity {v}");
        // vmax caps it.
        let v = corner_velocity([1.0, 0.0], [0.0, 1.0], 10.0, a, d);
        assert_eq!(v, 10.0);
    }

    #[test]
    fn quantization_no_drift_on_jagged_path() {
        // A jagged path with irrational-ish coordinates: per-segment rounding would drift, the
        // cumulative anchor must not.
        let mut pts = Vec::new();
        for i in 0..500 {
            let t = i as f64 * 0.7391;
            pts.push([10.0 + t.sin() * 30.0 + i as f64 * 0.13, 20.0 + (t * 1.618).cos() * 25.0]);
        }
        let p = params();
        let segs = plan(&[stroke(0, &pts)], &p);
        assert_quantization(&segs, &p, p.start); // tape ends back home
        // Velocity continuity: each motion segment's entry rate matches its geometry (spot check
        // that no rate exceeds vmax on an axis: |v_axis| ≤ vmax·√2·spmm).
        let max_rate = (p.travel_speed * 2.0f64.sqrt() * p.steps_per_mm * RATE_PER_STEP_HZ) as i32;
        for s in &segs {
            assert!(s.rate[0] <= max_rate + 1 && s.rate[1] <= max_rate + 1);
            assert!(s.rate[0] >= 0 && s.rate[1] >= 0, "LM rates are magnitudes");
        }
    }

    #[test]
    fn plan_structure_two_pens_and_fiducial() {
        let mut p = params();
        p.fiducial = Some([50.0, 50.0]);
        let segs = plan(
            &[stroke(0, &[[10.0, 10.0], [20.0, 10.0]]), stroke(1, &[[30.0, 10.0], [40.0, 10.0]])],
            &p,
        );
        // Collapse runs of motion segments to read the tape's event structure.
        let mut shape = Vec::new();
        for s in &segs {
            if s.kind == KIND_MOTION && shape.last() == Some(&KIND_MOTION) {
                continue;
            }
            shape.push(s.kind);
        }
        assert_eq!(
            shape,
            vec![
                KIND_PEN_UP,
                KIND_MOTION, // travel to fiducial
                KIND_PAUSE_FIDUCIAL,
                KIND_MOTION, // travel to stroke 1
                KIND_PEN_DOWN,
                KIND_MOTION, // draw
                KIND_PEN_UP,
                KIND_PAUSE_PENSWAP,
                KIND_MOTION, // travel to stroke 2
                KIND_PEN_DOWN,
                KIND_MOTION, // draw
                KIND_PEN_UP,
                KIND_MOTION, // return home
            ]
        );
        // The pen-swap pause names the incoming pen.
        let swap = segs.iter().find(|s| s.kind == KIND_PAUSE_PENSWAP).unwrap();
        assert_eq!(swap.pen, 1);
        // dist parity with buildToolpath: fiducial travel + travels + draws, NOT the return home.
        let d = |a: [f64; 2], b: [f64; 2]| ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
        let expected = d([0.0, 0.0], [50.0, 50.0])
            + d([50.0, 50.0], [10.0, 10.0])
            + 10.0
            + d([20.0, 10.0], [30.0, 10.0])
            + 10.0;
        let total = segs.last().unwrap().dist;
        assert!((total - expected).abs() < 1e-3, "dist total {total} vs {expected}");
        assert_quantization(&segs, &p, p.start);
    }

    #[test]
    fn forced_block_boundaries_bound_pause_latency() {
        // One long straight stroke: 2000 mm at draw speed 25 → 80 s. With a 5 s budget the planner
        // must break it into many rest points; every block between consecutive block_starts stays
        // within ~2× the budget (clamping slows blocks slightly, never lengthens them unboundedly).
        let p = params();
        let segs = plan(&[stroke(0, &[[0.0, 0.0], [2000.0, 0.0]])], &p);
        let draws: Vec<&Segment> =
            segs.iter().filter(|s| s.kind == KIND_MOTION && s.dist > 1.0).collect();
        let starts = draws.iter().filter(|s| s.block_start).count();
        assert!(starts > 10, "expected many forced rest points, got {starts}");
        let mut block_ms = 0.0f64;
        let mut worst = 0.0f64;
        for s in &draws {
            if s.block_start && block_ms > 0.0 {
                worst = worst.max(block_ms);
                block_ms = 0.0;
            }
            block_ms += s.duration_ms;
        }
        worst = worst.max(block_ms);
        assert!(
            worst < 2.0 * p.max_block_seconds * 1000.0,
            "longest block {worst} ms exceeds 2× budget"
        );
        assert_quantization(&segs, &p, p.start);
    }

    #[test]
    fn dot_stroke_is_pen_bounce() {
        // A single-point stroke: travel there, pen down, pen up — no draw motion.
        let p = params();
        let segs = plan(&[stroke(0, &[[10.0, 10.0]])], &p);
        let kinds: Vec<u8> = segs.iter().map(|s| s.kind).collect();
        let downs = kinds.iter().filter(|&&k| k == KIND_PEN_DOWN).count();
        assert_eq!(downs, 1);
        // No motion between pen_down and pen_up.
        let di = kinds.iter().position(|&k| k == KIND_PEN_DOWN).unwrap();
        assert_eq!(segs[di + 1].kind, KIND_PEN_UP);
    }

    #[test]
    fn empty_geometry_is_empty_tape() {
        let p = params();
        assert!(plan(&[], &p).is_empty());
        assert!(plan(&[stroke(0, &[])], &p).is_empty());
    }
}
