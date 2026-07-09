//! Tiny deterministic xorshift32 RNG shared by the seeded generators (generative patterns, Logo's
//! `random`). Not cryptographic — just fast, portable, and stable across platforms so a `seed`
//! param always reproduces the same marks.

pub struct Rng(u32);

impl Rng {
    pub fn new(s: u32) -> Self {
        Rng(s.max(1).wrapping_mul(2654435761).max(1))
    }
    pub fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    pub fn f32(&mut self) -> f32 {
        self.next() as f32 / u32::MAX as f32
    }
}
