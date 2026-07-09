//! The geometry IR on the Rust side, and its flat encoding for the WASM boundary.
//!
//! `Stroke`/`Point` are the ergonomic in-crate representation. `GeometryBuffers` is the
//! flat, CSR-style typed-array form handed to JS (mirrors `src/core/wasm/serde.ts`). Both
//! `optimize`, `clip` and `generate_word` return `GeometryBuffers`, so the JS side has exactly
//! one geometry decode path regardless of which marks produced the strokes.

use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

#[derive(Clone, Debug)]
pub struct Stroke {
    pub points: Vec<Point>,
    pub pen: u16,
    pub reversible: bool,
    /// Chain id. Strokes sharing a nonzero group form one ordered, contiguous, fixed-direction
    /// chain the optimizer plots as a single unit. 0 = free singleton (goes in the bag).
    pub group: u32,
}

/// Flat geometry returned to JS. Each getter hands back a fresh typed array (a copy).
#[wasm_bindgen]
pub struct GeometryBuffers {
    xy: Vec<f32>,
    pressure: Vec<f32>,
    offsets: Vec<u32>,
    pen: Vec<u16>,
    reversible: Vec<u8>,
    group: Vec<u32>,
}

#[wasm_bindgen]
impl GeometryBuffers {
    #[wasm_bindgen(getter)]
    pub fn xy(&self) -> Vec<f32> {
        self.xy.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn pressure(&self) -> Vec<f32> {
        self.pressure.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn offsets(&self) -> Vec<u32> {
        self.offsets.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn pen(&self) -> Vec<u16> {
        self.pen.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn reversible(&self) -> Vec<u8> {
        self.reversible.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn group(&self) -> Vec<u32> {
        self.group.clone()
    }
}

impl GeometryBuffers {
    pub fn from_strokes(strokes: &[Stroke]) -> Self {
        let mut xy = Vec::new();
        let mut pressure = Vec::new();
        let mut offsets = Vec::with_capacity(strokes.len() + 1);
        let mut pen = Vec::with_capacity(strokes.len());
        let mut reversible = Vec::with_capacity(strokes.len());
        let mut group = Vec::with_capacity(strokes.len());
        offsets.push(0);
        for s in strokes {
            for p in &s.points {
                xy.push(p.x);
                xy.push(p.y);
                pressure.push(p.pressure);
            }
            offsets.push((xy.len() / 2) as u32);
            pen.push(s.pen);
            reversible.push(s.reversible as u8);
            group.push(s.group);
        }
        GeometryBuffers {
            xy,
            pressure,
            offsets,
            pen,
            reversible,
            group,
        }
    }
}

/// Decode the flat input arrays (as flattened by `serde.ts`) back into strokes.
pub fn decode(
    xy: &[f32],
    pressure: &[f32],
    offsets: &[u32],
    pen: &[u16],
    reversible: &[u8],
    group: &[u32],
) -> Vec<Stroke> {
    (0..pen.len())
        .map(|i| {
            let start = offsets[i] as usize;
            let end = offsets[i + 1] as usize;
            let points = (start..end)
                .map(|p| Point {
                    x: xy[2 * p],
                    y: xy[2 * p + 1],
                    pressure: pressure[p],
                })
                .collect();
            Stroke {
                points,
                pen: pen[i],
                reversible: reversible[i] != 0,
                group: group[i],
            }
        })
        .collect()
}
