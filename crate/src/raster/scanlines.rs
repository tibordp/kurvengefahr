//! **Squiggle scanlines** (`scanlines`): horizontal lines `spacing` apart, each a sine wave whose
//! amplitude *and* frequency rise with local darkness. Light areas stay near-flat; dark areas erupt
//! into tight, tall squiggles — a single-pass, hand-plotter halftone that reads as tone from afar.

use super::{stroke, Grid, Params};
use crate::geom::Point;
use crate::geom::Stroke;

/// March step along each scanline (mm).
const STEP: f32 = crate::tess::RASTER_SCANLINE_STEP;

pub fn scanlines(grid: &Grid, p: &Params) -> Vec<Stroke> {
    let spacing = p.spacing.max(0.4);
    // Amplitude is unbounded — big wiggles may cross neighbouring lines, which is the point.
    let amp_max = p.amplitude.max(0.0);
    // Base spatial frequency (cycles/mm) from the knob; darkness multiplies it up to ~3×.
    let base_w = (p.frequency.max(0.1) * 0.12) * std::f32::consts::TAU;
    let mut out = Vec::new();
    let mut y = spacing * 0.5;
    while y <= grid.th {
        let mut phase = 0.0f32;
        let mut seg: Vec<Point> = Vec::new();
        let mut x = 0.0f32;
        while x <= grid.tw {
            let ink = grid.ink_mm(x, y);
            phase += base_w * (0.4 + 1.6 * ink) * STEP;
            let off = amp_max * ink * phase.sin();
            seg.push(Point { x, y: y + off, pressure: 1.0 });
            x += STEP;
        }
        if seg.len() >= 2 {
            out.push(stroke(seg));
        }
        y += spacing;
    }
    out
}
