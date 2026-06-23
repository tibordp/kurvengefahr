//! Place a synthesized word (model em-space) into element-local mm at its own origin: baseline at
//! y=0, x starting at 0. Page layout — wrapping, line baselines, spacing, alignment — is done by the
//! worker (manual typesetting), which translates each placed word to its (penX, baselineY).
//!
//! Coordinates: model em-space has +y up with the baseline ≈ 0; page mm has +y down, so `y = −up_mm`.

use crate::geom::{Point, Stroke};
use crate::model::LineInk;

/// Scale a word's em ink to mm (with optional extra slant), baseline at y=0 and x from 0.
pub fn place_word(ink: &LineInk, font_size_mm: f32, slant_deg: f32) -> Vec<Stroke> {
    let fs = font_size_mm;
    let tan = slant_deg.to_radians().tan();
    ink.strokes
        .iter()
        .map(|poly| {
            let points: Vec<Point> = poly
                .iter()
                .map(|p| {
                    let up_mm = p.y * fs; // em (up positive) → mm
                    Point {
                        x: p.x * fs + tan * up_mm, // extra slant shears by height
                        y: -up_mm,                 // baseline at 0, +y down
                        pressure: p.pressure,
                    }
                })
                .collect();
            Stroke {
                points,
                pen: 0,
                // Direction is free until TS decides (locked element → fixed); grouping is assigned
                // at element concatenation, so generators emit group 0.
                reversible: true,
                group: 0,
            }
        })
        .collect()
}
