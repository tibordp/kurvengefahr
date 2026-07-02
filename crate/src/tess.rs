//! Central geometry tuning: every tessellation resolution and tolerance in one conspicuous,
//! adjustable place. Lengths are **millimetres** (the page/plot unit) unless noted. Lower tolerance /
//! higher resolution → smoother output + more points (and bigger G-code); higher → coarser + fewer.
//!
//! Several of these are the *same idea* (curve → polyline flattening) in different importers; they're
//! kept as separate constants so each source can be tuned independently, but you can point them at a
//! shared value to unify. Pure numerical epsilons (`1e-6`, etc.) live at their use sites — they're
//! float-robustness guards, not fidelity knobs.

use std::f64::consts::PI;

// ── Curve flattening (Bézier → polyline): max chord deviation from the true curve, mm ───────────
/// SVG import. Adaptive subdivision stops once the curve is within this of its chord.
pub const SVG_FLATTEN_TOL: f32 = 0.15;
/// Native path/shape tessellation (rect / ellipse / path).
pub const PATH_FLATTEN_TOL: f32 = 0.1;
/// Text outline (glyph Bézier) flattening. NB: changing this shifts the Rust gold-test fixtures.
pub const TEXT_FLATTEN_TOL: f32 = 0.15;

// ── Arc / circle / spline tessellation (DXF import; sources that aren't adaptive Béziers) ───────
/// Angular step for arcs & circles, radians → segments per full turn = 2π / this (≈ 64).
pub const ARC_STEP_RAD: f64 = PI / 32.0;
pub const ARC_MIN_SEGMENTS: usize = 2;
pub const ARC_MAX_SEGMENTS: usize = 512;
/// Segments in a full DXF CIRCLE (then RDP-simplified by `DXF_SIMPLIFY_TOL`).
pub const CIRCLE_SEGMENTS: usize = 72;
/// B-spline samples per control point (then RDP-simplified) — fixed-count, so the simplify pass is
/// what actually right-sizes a CAD export's sea of tiny splines.
pub const SPLINE_SAMPLES_PER_CTRL: usize = 16;
pub const SPLINE_MIN_SAMPLES: usize = 16;
pub const SPLINE_MAX_SAMPLES: usize = 2048;

// ── DXF import tolerances, mm ───────────────────────────────────────────────────────────────────
/// RDP simplify applied to every flattened contour (CAD over-tessellates curves into many points).
pub const DXF_SIMPLIFY_TOL: f32 = 0.05;
/// Endpoint-coincidence tolerance for chaining DXF segments into polylines.
pub const DXF_WELD_TOL: f32 = 0.05;

// ── Toolpath cleanup / optimizer, mm ────────────────────────────────────────────────────────────
/// Two points within this are treated as the same vertex (stroke chaining / dedupe). 1 µm.
pub const COINCIDENT_TOL: f32 = 0.001;
/// Collinear interior-point drop tolerance.
pub const COLLINEAR_TOL: f32 = 0.002;

// ── Hatch fills, mm ─────────────────────────────────────────────────────────────────────────────
/// Concentric ellipse-ring flattening tolerance.
pub const ELLIPSE_FILL_TOL: f32 = 0.1;

// ── Non-destructive effects (roughen / warp / distort), mm ──────────────────────────────────────
/// Strokes are resampled to roughly this spacing before an effect displaces their points, so the
/// distortion reads smoothly even on long straight segments (which start with only two points).
pub const EFFECT_RESAMPLE_STEP: f32 = 1.0;

// ── Raster tracing: step length along a traced stroke, mm (sampling stride) ─────────────────────
pub const RASTER_SPIRAL_STEP: f32 = 0.5;
pub const RASTER_HATCH_STEP: f32 = 0.4;
pub const RASTER_SCANLINE_STEP: f32 = 0.5;
pub const RASTER_FLOW_STEP: f32 = 0.6;
/// Flow-streamline seed count = area · this · detail.
pub const RASTER_FLOW_SEED_DENSITY: f32 = 0.12;
