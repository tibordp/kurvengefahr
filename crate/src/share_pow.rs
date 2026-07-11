//! Proof-of-work for document sharing (`sha256-lz-v1`) — the solver side of the share API's
//! anti-abuse gate. The share dialog runs `scan` in a dedicated worker until it finds a nonce
//! whose PoW digest has enough leading zero bits; the server re-verifies with a single hash.
//!
//! The byte-level contract (must match `share-api` bit-for-bit; the shared fixture at
//! `share-api/testdata/pow_vectors.json` is normative):
//!
//!   pow_digest = SHA-256( blob_hash (32 bytes) || nonce.to_le_bytes() (8 bytes) )
//!   valid     ⇔ leading_zero_bits(pow_digest) ≥ difficulty
//!
//! `blob_hash` is the SHA-256 of the encrypted blob, so work can't be precomputed without the
//! content, and replaying a nonce only re-uploads the identical blob. The difficulty for a given
//! blob size is computed by the caller (TS mirrors the server's formula); this module only scans
//! and verifies. SHA-256 is hand-rolled (FIPS 180-4) — the 40-byte message pads to a single
//! block, and the crate stays free of crypto dependencies (precedent: the hand-rolled RNN).

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
    let mut w = [0u32; 64];
    for (i, word) in w.iter_mut().take(16).enumerate() {
        *word = u32::from_be_bytes(block[4 * i..4 * i + 4].try_into().unwrap());
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = (e & f) ^ (!e & g);
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(maj);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *s = s.wrapping_add(v);
    }
}

/// One-shot SHA-256 of an arbitrary message.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut state = H0;
    let mut chunks = data.chunks_exact(64);
    for block in &mut chunks {
        compress(&mut state, block.try_into().unwrap());
    }
    let rem = chunks.remainder();
    // Padding: 0x80, zeros, then the 64-bit big-endian bit length — one extra block, or two if
    // the remainder leaves fewer than 9 bytes of room.
    let mut tail = [0u8; 128];
    tail[..rem.len()].copy_from_slice(rem);
    tail[rem.len()] = 0x80;
    let blocks = if rem.len() + 9 <= 64 { 1 } else { 2 };
    tail[blocks * 64 - 8..blocks * 64].copy_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for b in 0..blocks {
        compress(&mut state, tail[b * 64..(b + 1) * 64].try_into().unwrap());
    }
    digest_bytes(&state)
}

fn digest_bytes(state: &[u32; 8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, s) in state.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&s.to_be_bytes());
    }
    out
}

/// The 40-byte PoW message (`hash || nonce`) pads to exactly one SHA-256 block; the scan reuses
/// the block and rewrites only the nonce bytes.
fn pow_block(blob_hash: &[u8; 32]) -> [u8; 64] {
    let mut block = [0u8; 64];
    block[..32].copy_from_slice(blob_hash);
    block[40] = 0x80;
    block[56..64].copy_from_slice(&(40u64 * 8).to_be_bytes());
    block
}

fn pow_digest_in(block: &mut [u8; 64], nonce: u64) -> [u8; 32] {
    block[32..40].copy_from_slice(&nonce.to_le_bytes());
    let mut state = H0;
    compress(&mut state, block);
    digest_bytes(&state)
}

/// The PoW digest for (blob hash, nonce) — `SHA-256(hash || nonce_le)`. Goes through the general
/// padding path, which doubles as a cross-check of `scan`'s precomputed-block fast path.
pub fn pow_digest(blob_hash: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut msg = [0u8; 40];
    msg[..32].copy_from_slice(blob_hash);
    msg[32..].copy_from_slice(&nonce.to_le_bytes());
    sha256(&msg)
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

/// Whether `nonce` satisfies `bits` of difficulty for `blob_hash`. One hash.
pub fn verify(blob_hash: &[u8; 32], nonce: u64, bits: u32) -> bool {
    leading_zero_bits(&pow_digest(blob_hash, nonce)) >= bits
}

/// Scan `count` nonces from `start` (wrapping); the first one meeting `bits`, or None to
/// continue from `start + count`. Chunked by the worker so progress/cancel stay responsive.
pub fn scan(blob_hash: &[u8; 32], start: u64, count: u32, bits: u32) -> Option<u64> {
    let mut block = pow_block(blob_hash);
    for i in 0..count as u64 {
        let nonce = start.wrapping_add(i);
        if leading_zero_bits(&pow_digest_in(&mut block, nonce)) >= bits {
            return Some(nonce);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// FIPS 180-4 / NIST CAVP vectors: empty, one-block, two-block, and cross-boundary lengths
    /// (55/56 bytes straddle the one-vs-two padding blocks).
    #[test]
    fn sha256_nist_vectors() {
        let cases = [
            (
                &b""[..],
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                &b"abc"[..],
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                &b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"[..],
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
        ];
        for (msg, want) in cases {
            assert_eq!(hex(&sha256(msg)), want);
        }
        assert_eq!(
            hex(&sha256(&[0x61u8; 55])),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            hex(&sha256(&[0x61u8; 56])),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
    }

    #[test]
    fn leading_zero_bits_edges() {
        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
        let mut d = [0u8; 32];
        d[0] = 0x80;
        assert_eq!(leading_zero_bits(&d), 0);
        d[0] = 0x01;
        assert_eq!(leading_zero_bits(&d), 7);
        d[0] = 0x00;
        d[1] = 0x7f;
        assert_eq!(leading_zero_bits(&d), 9);
    }

    /// The shared fixture is the normative cross-implementation contract (server + TS load the
    /// same file). Values there were generated by this module and hold it fixed forever.
    #[test]
    fn fixture_vectors() {
        let raw = std::fs::read_to_string("../share-api/testdata/pow_vectors.json").unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(fixture["algorithm"], "sha256-lz-v1");

        for v in fixture["sha256"].as_array().unwrap() {
            let msg = unhex(v["msg_hex"].as_str().unwrap());
            assert_eq!(hex(&sha256(&msg)), v["digest_hex"].as_str().unwrap());
        }

        for v in fixture["vectors"].as_array().unwrap() {
            let blob_hash: [u8; 32] = unhex(v["blob_hash_hex"].as_str().unwrap())
                .try_into()
                .unwrap();
            for case in v["cases"].as_array().unwrap() {
                let nonce = case["nonce"].as_u64().unwrap();
                let digest = pow_digest(&blob_hash, nonce);
                assert_eq!(hex(&digest), case["pow_digest_hex"].as_str().unwrap());
                let lz = case["leading_zero_bits"].as_u64().unwrap() as u32;
                assert_eq!(leading_zero_bits(&digest), lz);
                assert!(verify(&blob_hash, nonce, lz));
                assert!(!verify(&blob_hash, nonce, lz + 1));
            }
        }
    }

    #[test]
    fn scan_finds_and_respects_count() {
        let blob_hash = sha256(b"kurvengefahr");
        // At 8 bits a hit lands within a few hundred nonces; the scan must return the first one.
        let found = scan(&blob_hash, 0, 1 << 16, 8).expect("a 8-bit nonce within 2^16");
        assert!(verify(&blob_hash, found, 8));
        for n in 0..found {
            assert!(!verify(&blob_hash, n, 8), "scan skipped a valid nonce");
        }
        // A window that stops right before the hit must return None (count is exact).
        assert_eq!(scan(&blob_hash, 0, found as u32, 8), None);
        // Wrapping start: scanning from u64::MAX crosses zero without panicking.
        let _ = scan(&blob_hash, u64::MAX - 1, 4, 255);
    }
}
