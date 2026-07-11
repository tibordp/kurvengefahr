//! Proof-of-work verification (`sha256-lz-v1`) — the server side of the upload gate. The client
//! (kg_core's `share_pow`, run in a worker) finds the nonce; verification is a single hash.
//!
//! Contract (normative fixture: `testdata/pow_vectors.json`, shared with the client suites):
//!
//!   pow_digest = SHA-256( blob_hash (32 bytes) || nonce.to_le_bytes() (8 bytes) )
//!   valid     ⇔ leading_zero_bits(pow_digest) ≥ difficulty(blob_len)
//!
//! Difficulty scales with blob size so bulk uploads pay proportionally:
//!   n = max(1, ceil(len / size_step));  d = min(max_bits, base_bits + floor(log2(n)))
//! Expected work is 2^d hashes — linear in size (doubling the blob adds one bit). Binding the
//! digest to the blob hash means work can't be precomputed without the content, and a replayed
//! nonce only re-PUTs the identical blob.

use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug)]
pub struct PowParams {
    pub base_bits: u32,
    pub size_step: u32,
    pub max_bits: u32,
}

/// Required leading zero bits for a blob of `len` bytes.
pub fn difficulty(len: u64, p: &PowParams) -> u32 {
    let n = len.max(1).div_ceil(p.size_step.max(1) as u64);
    let extra = 63 - n.leading_zeros(); // floor(log2(n)), n >= 1
    (p.base_bits + extra).min(p.max_bits)
}

/// Zero bits from the digest's most significant bit down to the first set bit.
pub fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for &b in digest {
        if b == 0 {
            bits += 8;
        } else {
            bits += b.leading_zeros();
            break;
        }
    }
    bits
}

/// Whether `nonce` meets `required_bits` for `blob_hash`. Exactly one SHA-256.
pub fn verify(blob_hash: &[u8; 32], nonce: u64, required_bits: u32) -> bool {
    let mut h = Sha256::new();
    h.update(blob_hash);
    h.update(nonce.to_le_bytes());
    leading_zero_bits(&h.finalize().into()) >= required_bits
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../testdata/pow_vectors.json");

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn fixture_params(f: &serde_json::Value) -> PowParams {
        PowParams {
            base_bits: f["params"]["base_bits"].as_u64().unwrap() as u32,
            size_step: f["params"]["size_step"].as_u64().unwrap() as u32,
            max_bits: f["params"]["max_bits"].as_u64().unwrap() as u32,
        }
    }

    #[test]
    fn difficulty_matches_fixture() {
        let f = fixture();
        let p = fixture_params(&f);
        for row in f["difficulty_table"].as_array().unwrap() {
            let len = row["len"].as_u64().unwrap();
            let want = row["difficulty"].as_u64().unwrap() as u32;
            assert_eq!(difficulty(len, &p), want, "len={len}");
        }
    }

    #[test]
    fn difficulty_boundaries() {
        let p = PowParams {
            base_bits: 13,
            size_step: 1024,
            max_bits: 30,
        };
        assert_eq!(difficulty(0, &p), 13, "len 0 treated as 1");
        assert_eq!(difficulty(1024, &p), 13);
        assert_eq!(
            difficulty(1025, &p),
            14,
            "one byte over the step adds a bit"
        );
        assert_eq!(difficulty(u64::MAX, &p), 30, "max_bits clamps");
        // A degenerate size_step of 0 must not divide by zero.
        let z = PowParams {
            base_bits: 13,
            size_step: 0,
            max_bits: 30,
        };
        assert_eq!(difficulty(1, &z), 13);
    }

    #[test]
    fn verify_matches_fixture() {
        let f = fixture();
        for v in f["vectors"].as_array().unwrap() {
            let blob_hash: [u8; 32] = unhex(v["blob_hash_hex"].as_str().unwrap())
                .try_into()
                .unwrap();
            for case in v["cases"].as_array().unwrap() {
                let nonce = case["nonce"].as_u64().unwrap();
                let lz = case["leading_zero_bits"].as_u64().unwrap() as u32;
                let mut h = Sha256::new();
                h.update(blob_hash);
                h.update(nonce.to_le_bytes());
                let digest: [u8; 32] = h.finalize().into();
                assert_eq!(
                    digest.as_slice(),
                    unhex(case["pow_digest_hex"].as_str().unwrap()).as_slice()
                );
                assert_eq!(leading_zero_bits(&digest), lz);
                assert!(verify(&blob_hash, nonce, lz));
                assert!(!verify(&blob_hash, nonce, lz + 1));
            }
        }
    }

    #[test]
    fn leading_zero_bits_edges() {
        assert_eq!(leading_zero_bits(&[0; 32]), 256);
        let mut d = [0u8; 32];
        d[0] = 0x80;
        assert_eq!(leading_zero_bits(&d), 0);
        d[0] = 0;
        d[1] = 0x7f;
        assert_eq!(leading_zero_bits(&d), 9);
    }
}
