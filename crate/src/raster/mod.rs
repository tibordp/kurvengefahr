//! Raster → vector: turn a bitmap into pen strokes. JS decodes the image (it owns the full image
//! stack) and hands us raw RGBA bytes; Rust only ever sees pixels, so no image-decoding crate is
//! needed. Output is element-local mm (origin 0,0), fit to the element's physical box —
//! place→clip→optimize→emit does the rest, exactly like `shapes`.
//!
//! This is the **stylization** layer: one image, many ways to render it as strokes. Each method is a
//! self-contained submodule producing `Vec<Stroke>` from a shared [`Grid`] (the inkness field) plus
//! [`Params`]; `vectorize` just dispatches on `params.method`. Adding a method = a new submodule +
//! one match arm + the UI control — nothing downstream changes (it's all `Stroke[]` either way).
//!
//! Methods, by flavour:
//! - **contours** — threshold + trace ink/paper boundary (faithful, line-art).
//! - **contourmap** — topographic iso-tone lines (marching squares at N levels).
//! - **hatch** — engraving-style tonal cross-hatch (darker tones accrue more passes).
//! - **scanlines** — squiggle scanlines whose wiggle grows with darkness.
//! - **tsp** — one continuous line threaded through a density-weighted point cloud (TSP art).
//! - **flowfield** — streamlines that flow along the image's edges.
//! - **spiral** — one Archimedean spiral, radially modulated by darkness.

mod centerline;
mod contourmap;
mod contours;
mod flow;
mod scanlines;
mod spiral;
mod tone;
mod tsp;

use serde::Deserialize;

use crate::geom::{Point, Stroke};

/// Vectorize an RGBA image into pen strokes. `rgba` is row-major `width*height*4` bytes; `params` is
/// the JSON-serialized [`Params`] (the union of every method's knobs — see `src/elements/raster`).
/// A flat positional signature stopped scaling once methods multiplied, so the boundary carries one
/// JSON blob and Rust owns the schema.
pub fn vectorize(rgba: &[u8], width: u32, height: u32, params: &str) -> Vec<Stroke> {
    let w = width as usize;
    let h = height as usize;
    if w == 0 || h == 0 || rgba.len() < w * h * 4 {
        return vec![];
    }
    let p: Params = serde_json::from_str(params).unwrap_or_default();
    if p.target_w_mm <= 0.0 || p.target_h_mm <= 0.0 {
        return vec![];
    }
    let grid = Grid::build(rgba, w, h, p.target_w_mm, p.target_h_mm, p.invert);
    match p.method.as_str() {
        "centerline" => centerline::centerline(&grid, &p),
        "contourmap" => contourmap::contourmap(&grid, &p),
        "hatch" => tone::hatch(&grid, &p),
        "scanlines" => scanlines::scanlines(&grid, &p),
        "tsp" => tsp::tsp(&grid, &p),
        "flowfield" => flow::flow(&grid, &p),
        "spiral" => spiral::spiral(&grid, &p),
        // "contours" and any unknown method fall through to faithful outline tracing.
        _ => contours::contours(&grid, &p),
    }
}

/// The union of every method's parameters, deserialized from the JS params object (camelCase keys).
/// `#[serde(default)]` means a params object that omits a method's fields (every doc does — each only
/// carries the active method's knobs meaningfully) still deserializes; absent fields take the
/// [`Default`] below. Unknown fields (e.g. `imageId`) are ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Params {
    pub method: String,
    /// Physical box the pixel grid is fit into (mm). Renamed to match the TS `RasterParams` keys
    /// (the worker just `JSON.stringify`s the params object).
    #[serde(rename = "targetWidthMm")]
    pub target_w_mm: f32,
    #[serde(rename = "targetHeightMm")]
    pub target_h_mm: f32,
    /// Swap ink/paper: trace the light areas instead of the dark.
    pub invert: bool,
    /// Seed for the randomized methods (tsp/flow). Same seed ⇒ same arrangement.
    pub seed: u32,

    // contours / contourmap
    /// Luma cutoff 0..255 (contours): ink = darker than this. Higher = more ink.
    pub threshold: u32,
    /// RDP / smoothing tolerance in mm.
    pub simplify_tol: f32,
    /// Despeckle: drop contours under this many px².
    pub min_area: f32,

    // hatch / scanlines / spiral / contourmap — line spacing & modulation
    /// Line spacing / spiral pitch in mm.
    pub spacing: f32,
    /// Base hatch / flow angle in degrees.
    pub angle: f32,
    /// Tone bands (hatch cross-hatch depth; contourmap iso-levels).
    pub levels: u32,
    /// Wiggle amplitude in mm (scanlines/spiral).
    pub amplitude: f32,
    /// Wiggle frequency (scanlines waves/mm·10, spiral oscillations/turn).
    pub frequency: f32,

    // tsp / flow — sampling density
    /// 0..1 density of sampled points / seeds.
    pub detail: f32,
    /// Flow streamline max length (steps).
    pub flow_steps: u32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            method: "contours".into(),
            target_w_mm: 100.0,
            target_h_mm: 100.0,
            invert: false,
            seed: 1,
            threshold: 128,
            simplify_tol: 0.3,
            min_area: 8.0,
            spacing: 1.5,
            angle: 45.0,
            levels: 4,
            amplitude: 1.2,
            frequency: 5.0,
            detail: 0.5,
            flow_steps: 80,
        }
    }
}

/// The inkness field: per-pixel "how much to draw here" in 0..1 (1 = full ink), with `invert`
/// already applied, plus the px→mm mapping. Every method samples this rather than touching RGBA, so
/// compositing/luma/invert live in exactly one place.
pub struct Grid {
    pub w: usize,
    pub h: usize,
    /// Row-major inkness, 0..1.
    ink: Vec<f32>,
    /// Physical box (mm); pixel (px,py) maps to mm (px*sx, py*sy) where sx=tw/w.
    pub tw: f32,
    pub th: f32,
    pub sx: f32,
    pub sy: f32,
}

impl Grid {
    pub fn build(rgba: &[u8], w: usize, h: usize, tw: f32, th: f32, invert: bool) -> Grid {
        let ink: Vec<f32> = (0..w * h)
            .map(|i| {
                let p = i * 4;
                let r = rgba[p] as f32;
                let g = rgba[p + 1] as f32;
                let b = rgba[p + 2] as f32;
                let a = rgba[p + 3] as f32 / 255.0;
                // Composite over white so transparent pixels read as paper, then luma → inkness
                // (dark = high). `invert` swaps which tone we ink.
                let luma = (0.299 * r + 0.587 * g + 0.114 * b) * a + 255.0 * (1.0 - a);
                let dark = 1.0 - luma / 255.0;
                if invert {
                    1.0 - dark
                } else {
                    dark
                }
            })
            .collect();
        Grid { w, h, ink, tw, th, sx: tw / w as f32, sy: th / h as f32 }
    }

    /// Inkness at a row-major pixel index (no bounds adjust; caller guarantees `i < w*h`).
    #[inline]
    pub fn ink_at(&self, i: usize) -> f32 {
        self.ink[i]
    }

    /// Inkness at integer pixel (clamped).
    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.ink[y.min(self.h - 1) * self.w + x.min(self.w - 1)]
    }

    /// Bilinearly-sampled inkness at a point in **mm** (box coords). Outside the box → 0 (paper).
    pub fn ink_mm(&self, x: f32, y: f32) -> f32 {
        if x < 0.0 || y < 0.0 || x > self.tw || y > self.th {
            return 0.0;
        }
        // Pixel-centre sampling: pixel i covers [i, i+1) in px space, centre at i+0.5.
        let fx = (x / self.sx - 0.5).clamp(0.0, self.w as f32 - 1.0);
        let fy = (y / self.sy - 0.5).clamp(0.0, self.h as f32 - 1.0);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(self.w - 1);
        let y1 = (y0 + 1).min(self.h - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let a = self.ink[y0 * self.w + x0];
        let b = self.ink[y0 * self.w + x1];
        let c = self.ink[y1 * self.w + x0];
        let d = self.ink[y1 * self.w + x1];
        let top = a + (b - a) * tx;
        let bot = c + (d - c) * tx;
        top + (bot - top) * ty
    }
}

/// Small deterministic PRNG (xorshift64*) so randomized methods are reproducible per `seed`.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u32) -> Self {
        // Mix the seed so seed=0 still yields a nonzero, well-distributed state.
        Rng((seed as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ 0xD1B54A32D192ED03)
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        (x.wrapping_mul(0x2545F4914F6CDD1D) >> 32) as u32
    }
    /// Uniform 0..1.
    #[inline]
    pub fn f32(&mut self) -> f32 {
        self.next_u32() as f32 / (u32::MAX as f32 + 1.0)
    }
}

/// Convenience constructor for a free, forward-only stroke from mm points.
fn stroke(points: Vec<Point>) -> Stroke {
    Stroke { points, pen: 0, reversible: true, group: 0 }
}

fn pt(x: f32, y: f32) -> Point {
    Point { x, y, pressure: 1.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 48×48 radial gradient (dark centre → light edges) as RGBA — enough tone for every method.
    fn gradient() -> (Vec<u8>, u32, u32) {
        let (w, h) = (48usize, 48usize);
        let mut rgba = vec![255u8; w * h * 4];
        for y in 0..h {
            for x in 0..w {
                let dx = x as f32 - w as f32 / 2.0;
                let dy = y as f32 - h as f32 / 2.0;
                let r = (dx * dx + dy * dy).sqrt() / (w as f32 / 2.0);
                let v = (r.clamp(0.0, 1.0) * 255.0) as u8; // dark centre
                let p = (y * w + x) * 4;
                rgba[p] = v;
                rgba[p + 1] = v;
                rgba[p + 2] = v;
            }
        }
        (rgba, w as u32, h as u32)
    }

    fn run(method: &str) -> Vec<Stroke> {
        let (rgba, w, h) = gradient();
        let json = format!(
            r#"{{"method":"{method}","targetWidthMm":60,"targetHeightMm":60,"seed":7,
               "threshold":140,"simplifyTol":0.3,"minArea":2,"spacing":2.0,"angle":30,
               "levels":4,"amplitude":1.5,"frequency":5,"detail":0.6,"flowSteps":60}}"#
        );
        vectorize(&rgba, w, h, &json)
    }

    #[test]
    fn every_method_produces_in_bounds_strokes() {
        for method in [
            "contours", "contourmap", "hatch", "scanlines", "tsp", "flowfield", "spiral",
        ] {
            let out = run(method);
            assert!(!out.is_empty(), "method {method} produced no strokes");
            for s in &out {
                assert!(s.points.len() >= 2, "method {method} has a degenerate stroke");
                for p in &s.points {
                    // Allow a small margin (smoothing leashes / wiggle can stray slightly).
                    assert!(
                        p.x >= -3.0 && p.x <= 63.0 && p.y >= -3.0 && p.y <= 63.0,
                        "method {method} point ({}, {}) out of box",
                        p.x,
                        p.y,
                    );
                }
            }
        }
    }

    #[test]
    fn invert_flips_which_tone_inks() {
        // The radial gradient is dark in the centre, so TSP — which threads dark areas — sits more
        // toward the centre; with invert the path shifts outward. Compare mean distance-from-centre.
        let (rgba, w, h) = gradient();
        let mean_r = |json: &str| {
            let out = vectorize(&rgba, w, h, json);
            let (mut sum, mut n) = (0.0f32, 0.0f32);
            for s in &out {
                for p in &s.points {
                    sum += ((p.x - 30.0).powi(2) + (p.y - 30.0).powi(2)).sqrt();
                    n += 1.0;
                }
            }
            sum / n.max(1.0)
        };
        let normal = r#"{"method":"tsp","targetWidthMm":60,"targetHeightMm":60,"seed":3,"detail":0.6,"invert":false}"#;
        let inv = r#"{"method":"tsp","targetWidthMm":60,"targetHeightMm":60,"seed":3,"detail":0.6,"invert":true}"#;
        assert!(mean_r(normal) < mean_r(inv), "invert should push the path outward");
    }
}
