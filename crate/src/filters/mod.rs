//! Non-destructive geometry filters: post-`generate()` passes that displace a stroke's points
//! (hand-drawn roughen, sine/anharmonic warp, sketch overdraw, twist/bulge) without touching the
//! source element. They run in **element-local space** before `place`, stack in order, and preserve
//! every stroke's pen/reversible/group metadata. Like raster, the param *union* crosses the WASM
//! boundary as one JSON blob (an array of specs) — a positional signature wouldn't scale across
//! filter kinds — and Rust owns the schema ([`FilterSpec`]); `apply` dispatches on `spec.kind`.
//!
//! Adding a filter = a new submodule with `apply(strokes, spec) -> Vec<Stroke>`, one match arm in
//! [`apply`], the relevant fields on [`FilterSpec`], and the TS registry entry + inspector control.

mod bulge;
mod roughen;
mod sketch;
mod twist;
mod wave;

use serde::Deserialize;

use crate::geom::{Point, Stroke};

/// One filter in an element's stack. A single union struct (rather than a tagged enum) so the JSON
/// the TS registry produces — `{type, enabled, …knobs}` — deserializes directly, unknown/missing
/// knobs defaulting to 0. `kind` selects the pass; each pass reads only the fields it needs.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterSpec {
    #[serde(rename = "type")]
    pub kind: String,
    pub enabled: bool,
    pub seed: u32,
    /// Displacement amount, mm (roughen jitter / wave height).
    pub amplitude_mm: f32,
    /// Roughen: resample/feature spacing (smaller = finer wobble), mm.
    pub detail_mm: f32,
    /// Roughen: extra fine high-frequency tremor, mm.
    pub tremor_mm: f32,
    /// Wave: period along the wave axis, mm.
    pub wavelength_mm: f32,
    /// Wave/twist: direction of the wave axis / twist baseline, degrees.
    pub angle_deg: f32,
    /// Wave: phase offset, degrees.
    pub phase_deg: f32,
    /// Wave: number of summed harmonics (1 = pure sine; >1 = anharmonic).
    pub harmonics: u32,
    /// Sketch: number of overdrawn passes per stroke.
    pub passes: u32,
    /// Sketch: per-pass wander amount, mm.
    pub offset_mm: f32,
    /// Twist/bulge: falloff radius from the geometry centre, mm.
    pub radius_mm: f32,
    /// Twist: rotation at the centre, degrees. Bulge: −1 pinch … +1 bulge.
    pub strength: f32,
}

/// Apply a stack of filters (JSON array of [`FilterSpec`]) to local-space geometry, in order. A
/// disabled or unknown-kind spec is a no-op. Malformed JSON → the input unchanged.
pub fn apply(strokes: &[Stroke], params_json: &str) -> Vec<Stroke> {
    let specs: Vec<FilterSpec> = match serde_json::from_str(params_json) {
        Ok(s) => s,
        Err(_) => return strokes.to_vec(),
    };
    let mut cur = strokes.to_vec();
    for spec in &specs {
        if !spec.enabled {
            continue;
        }
        cur = match spec.kind.as_str() {
            "roughen" => roughen::apply(&cur, spec),
            "wave" => wave::apply(&cur, spec),
            "sketch" => sketch::apply(&cur, spec),
            "twist" => twist::apply(&cur, spec),
            "bulge" => bulge::apply(&cur, spec),
            _ => cur,
        };
    }
    cur
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

#[inline]
fn lerp_point(a: Point, b: Point, t: f32) -> Point {
    Point {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
    }
}

/// A polyline is closed when its ends coincide (a shape contour) — filters must keep it closed.
pub fn is_closed(pts: &[Point]) -> bool {
    pts.len() >= 4 && (pts[0].x - pts[pts.len() - 1].x).hypot(pts[0].y - pts[pts.len() - 1].y) < 1e-3
}

/// Resample a polyline to roughly `step`-spaced points (interpolating pressure), keeping the exact
/// first and last vertices. Short/degenerate inputs pass through. So a long straight segment gains
/// the interior points a displacement needs to actually curve.
pub fn resample(pts: &[Point], step: f32) -> Vec<Point> {
    if pts.len() < 2 {
        return pts.to_vec();
    }
    let step = step.max(0.05);
    let mut out = vec![pts[0]];
    let mut acc = 0.0f32; // distance already covered past the last emitted sample
    for i in 1..pts.len() {
        let a = pts[i - 1];
        let b = pts[i];
        let seg = (b.x - a.x).hypot(b.y - a.y);
        if seg < 1e-9 {
            continue;
        }
        let mut d = step - acc;
        while d < seg {
            out.push(lerp_point(a, b, d / seg));
            d += step;
        }
        acc = seg - (d - step);
    }
    let last = pts[pts.len() - 1];
    let l = *out.last().unwrap();
    if (l.x - last.x).abs() > 1e-6 || (l.y - last.y).abs() > 1e-6 {
        out.push(last);
    }
    out
}

/// Axis-aligned bounding-box centre of all points across the strokes (the pivot for twist/bulge).
pub fn centroid(strokes: &[Stroke]) -> (f32, f32) {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for s in strokes {
        for p in &s.points {
            x0 = x0.min(p.x);
            y0 = y0.min(p.y);
            x1 = x1.max(p.x);
            y1 = y1.max(p.y);
        }
    }
    if x0.is_finite() {
        ((x0 + x1) * 0.5, (y0 + y1) * 0.5)
    } else {
        (0.0, 0.0)
    }
}

// ── deterministic value noise (no rand crate; stable per seed for re-roll determinism) ────────────

#[inline]
fn hash_u32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

#[inline]
fn mix(a: u32, b: u32) -> u32 {
    hash_u32(a ^ b.wrapping_mul(0x9e37_79b1))
}

/// A pseudo-random value in [-1, 1] at integer lattice index `i` for stream `seed`.
#[inline]
fn grad(i: i32, seed: u32) -> f32 {
    (mix(i as u32, seed) as f32 / u32::MAX as f32) * 2.0 - 1.0
}

/// Smooth 1-D value noise in [-1, 1] (smoothstep-interpolated lattice). `t` is in lattice units.
pub fn noise1(t: f32, seed: u32) -> f32 {
    let i = t.floor();
    let f = t - i;
    let u = f * f * (3.0 - 2.0 * f);
    let a = grad(i as i32, seed);
    let b = grad(i as i32 + 1, seed);
    a + (b - a) * u
}

/// Two-octave 1-D fractal noise in roughly [-1, 1] — the roughen wobble (low octave) plus a finer
/// detail octave.
pub fn fbm1(t: f32, seed: u32) -> f32 {
    noise1(t, seed) * 0.7 + noise1(t * 2.17 + 11.3, seed ^ 0x68bc_21eb) * 0.3
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line() -> Vec<Stroke> {
        vec![Stroke {
            points: vec![
                Point { x: 0.0, y: 0.0, pressure: 1.0 },
                Point { x: 100.0, y: 0.0, pressure: 1.0 },
            ],
            pen: 3,
            reversible: true,
            group: 7,
        }]
    }

    fn square() -> Vec<Stroke> {
        vec![Stroke {
            points: vec![
                Point { x: 0.0, y: 0.0, pressure: 1.0 },
                Point { x: 10.0, y: 0.0, pressure: 1.0 },
                Point { x: 10.0, y: 10.0, pressure: 1.0 },
                Point { x: 0.0, y: 10.0, pressure: 1.0 },
                Point { x: 0.0, y: 0.0, pressure: 1.0 },
            ],
            pen: 0,
            reversible: false,
            group: 0,
        }]
    }

    #[test]
    fn disabled_and_empty_are_noops() {
        let s = line();
        assert_eq!(apply(&s, "[]").len(), 1);
        let off = r#"[{"type":"roughen","enabled":false,"amplitudeMm":5,"detailMm":4,"tremorMm":0,"seed":1}]"#;
        let out = apply(&s, off);
        assert_eq!(out[0].points.len(), 2, "disabled filter must not touch geometry");
        // Malformed JSON → unchanged.
        assert_eq!(apply(&s, "not json")[0].points.len(), 2);
    }

    #[test]
    fn roughen_is_deterministic_and_keeps_metadata() {
        let json = r#"[{"type":"roughen","enabled":true,"amplitudeMm":2,"detailMm":4,"tremorMm":0.2,"seed":42}]"#;
        let a = apply(&line(), json);
        let b = apply(&line(), json);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].pen, 3);
        assert_eq!(a[0].group, 7);
        assert!(a[0].points.len() > 2, "resampled + displaced");
        // Same seed → identical output.
        assert_eq!(a[0].points.len(), b[0].points.len());
        for (p, q) in a[0].points.iter().zip(&b[0].points) {
            assert!((p.x - q.x).abs() < 1e-6 && (p.y - q.y).abs() < 1e-6);
        }
        // A different seed yields a different path.
        let c = apply(&line(), &json.replace("42", "43"));
        let diff = a[0].points.iter().zip(&c[0].points).any(|(p, q)| (p.y - q.y).abs() > 1e-4);
        assert!(diff, "different seed → different roughening");
    }

    #[test]
    fn closed_contour_stays_closed() {
        let json = r#"[{"type":"roughen","enabled":true,"amplitudeMm":3,"detailMm":2,"tremorMm":0,"seed":1}]"#;
        let out = apply(&square(), json);
        let p = &out[0].points;
        assert!(is_closed(p), "roughen must keep a closed shape closed");
    }

    #[test]
    fn wave_displaces_the_middle() {
        // Wave along +x (angle 0) displaces in y; quarter-wavelength in should be near the peak.
        let json = r#"[{"type":"wave","enabled":true,"amplitudeMm":5,"wavelengthMm":40,"angleDeg":0,"phaseDeg":0,"harmonics":1}]"#;
        let out = apply(&line(), json);
        let max_y = out[0].points.iter().fold(0.0f32, |m, p| m.max(p.y.abs()));
        assert!(max_y > 3.0, "wave should push points off the baseline (got {max_y})");
    }

    #[test]
    fn sketch_multiplies_passes() {
        let json = r#"[{"type":"sketch","enabled":true,"passes":3,"offsetMm":0.5,"seed":1}]"#;
        let out = apply(&line(), json);
        assert_eq!(out.len(), 3, "one stroke → 3 overdrawn passes");
        assert!(out.iter().all(|s| s.pen == 3 && s.group == 7));
    }
}
