//! Content addresses. A blob's id is the SHA-256 of its stored bytes, base64url unpadded in
//! URLs — exactly 43 characters. Parsing is strict (canonical encoding only), so an id is
//! either exactly right or rejected; there is no normalization.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct BlobId(pub [u8; 32]);

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidId;

impl BlobId {
    pub fn of(body: &[u8]) -> Self {
        BlobId(Sha256::digest(body).into())
    }
}

impl std::str::FromStr for BlobId {
    type Err = InvalidId;

    fn from_str(s: &str) -> Result<Self, InvalidId> {
        if s.len() != 43 {
            return Err(InvalidId);
        }
        // The default engine rejects trailing-bit garbage, so only the canonical encoding of
        // each 32-byte value parses.
        let bytes = URL_SAFE_NO_PAD.decode(s).map_err(|_| InvalidId)?;
        Ok(BlobId(bytes.try_into().map_err(|_| InvalidId)?))
    }
}

impl std::fmt::Display for BlobId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&URL_SAFE_NO_PAD.encode(self.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let id = BlobId::of(b"kurvengefahr");
        let s = id.to_string();
        assert_eq!(s.len(), 43);
        assert_eq!(s.parse::<BlobId>().unwrap(), id);
    }

    #[test]
    fn rejects_malformed() {
        let good = BlobId::of(b"x").to_string();
        assert!(good[..42].parse::<BlobId>().is_err(), "too short");
        assert!(format!("{good}A").parse::<BlobId>().is_err(), "too long");
        assert!(
            format!("+{}", &good[1..]).parse::<BlobId>().is_err(),
            "not url-safe"
        );
        assert!(
            format!("{}=", &good[..42]).parse::<BlobId>().is_err(),
            "padded"
        );
        // 43 chars decode to 258 bits; the final char's low 2 bits must be zero. "A…AB" sets
        // one of them — a non-canonical alias of the all-zero id, and must be rejected.
        let canonical = "A".repeat(43);
        assert_eq!(canonical.parse::<BlobId>().unwrap(), BlobId([0; 32]));
        assert!(
            format!("{}B", "A".repeat(42)).parse::<BlobId>().is_err(),
            "trailing bits"
        );
    }
}
