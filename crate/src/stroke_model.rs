//! StrokeModel: `text → glyphs` (normalised em units; x advances, baseline y=0, +y up).
//! This is the ML-shaped box. v1 is `SyntheticStrokeModel`, a deterministic scribble
//! generator (seeded PRNG, no global RNG) so the whole pipeline runs without model weights.
//! The real Graves RNN-MDN will implement the same `StrokeModel` trait — the WASM boundary
//! (`generate_handwriting`) and everything in JS stay identical.

/// Em metrics, shared with the typesetter.
pub const ASCENDER: f32 = 0.75;
pub const X_HEIGHT: f32 = 0.5;
pub const DESCENDER: f32 = 0.2;
pub const SPACE_ADVANCE: f32 = 0.32;
pub const GLYPH_ADVANCE: f32 = 0.62;

pub struct NormPoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

/// One character: its normalised strokes plus advance width (em). Spaces/newlines carry
/// no strokes; the typesetter switches on `ch`.
pub struct Glyph {
    pub ch: char,
    pub strokes: Vec<Vec<NormPoint>>,
    pub advance: f32,
}

pub trait StrokeModel {
    fn generate(&self, text: &str, seed: u32) -> Vec<Glyph>;
}

/// Deterministic PRNG (mulberry32) — keeps generation reproducible so element memoization
/// in JS stays valid for a given (text, seed).
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Mulberry32 { state: seed }
    }
    fn next_f32(&mut self) -> f32 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let a = self.state;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        ((t ^ (t >> 14)) as f32) / 4_294_967_296.0
    }
}

pub struct SyntheticStrokeModel;

impl StrokeModel for SyntheticStrokeModel {
    fn generate(&self, text: &str, seed: u32) -> Vec<Glyph> {
        let mut counter = seed;
        let mut glyphs = Vec::new();
        for ch in text.chars() {
            match ch {
                ' ' | '\t' => glyphs.push(Glyph {
                    ch,
                    strokes: Vec::new(),
                    advance: SPACE_ADVANCE,
                }),
                '\n' => glyphs.push(Glyph {
                    ch,
                    strokes: Vec::new(),
                    advance: 0.0,
                }),
                _ => {
                    counter = counter.wrapping_add((ch as u32).wrapping_mul(2_654_435_761));
                    glyphs.push(Glyph {
                        ch,
                        strokes: glyph_strokes(counter),
                        advance: GLYPH_ADVANCE,
                    });
                }
            }
        }
        glyphs
    }
}

/// Placeholder ink: one wobbly cursive-ish polyline per glyph. Not real letters — a stand-in
/// until the RNN lands — but it produces realistic point counts to exercise the rest of the
/// pipeline (typeset → optimize → emit).
fn glyph_strokes(seed: u32) -> Vec<Vec<NormPoint>> {
    let mut rng = Mulberry32::new(seed);
    let n = 12 + (rng.next_f32() * 6.0) as usize;
    let x0 = 0.06 + rng.next_f32() * 0.04;
    let x1 = GLYPH_ADVANCE - 0.06 - rng.next_f32() * 0.04;
    let amp = X_HEIGHT * (0.7 + rng.next_f32() * 0.5);
    let phase = rng.next_f32() * std::f32::consts::TAU;
    let loops = 1 + (rng.next_f32() * 2.0) as i32;

    let denom = (n.max(2) - 1) as f32;
    let mut pts = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / denom;
        let x = x0 + (x1 - x0) * t + (rng.next_f32() - 0.5) * 0.03;
        let wave = (phase + t * std::f32::consts::PI * loops as f32).sin();
        let tilt = t * 0.15;
        let mut y = X_HEIGHT * 0.5 + amp * 0.5 * wave + tilt * (rng.next_f32() - 0.5);
        y = y.clamp(-DESCENDER, ASCENDER);
        pts.push(NormPoint {
            x,
            y,
            pressure: 1.0,
        });
    }
    vec![pts]
}
