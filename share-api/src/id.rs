//! Content addresses. A blob's id is the **first 16 bytes** of the SHA-256 of its stored bytes,
//! base64url unpadded in URLs — exactly 22 characters. Truncation is deliberate: the id needs
//! unguessability and second-preimage resistance (both fully intact at 128 bits), not collision
//! resistance — writes are first-come-permanent and blob contents are additionally authenticated
//! client-side by AES-GCM, so a crafted colliding blob only ever fails decryption. The upload
//! proof-of-work stays bound to the FULL 32-byte digest (see `pow`). Parsing is strict
//! (canonical encoding only), so an id is either exactly right or rejected.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

pub const ID_BYTES: usize = 16;
pub const ID_CHARS: usize = 22; // ceil(16 * 8 / 6)

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct BlobId(pub [u8; ID_BYTES]);

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidId;

impl BlobId {
    /// The id for a body — truncated from the full digest.
    pub fn of(body: &[u8]) -> Self {
        Self::from_digest(&Sha256::digest(body).into())
    }

    pub fn from_digest(digest: &[u8; 32]) -> Self {
        BlobId(digest[..ID_BYTES].try_into().unwrap())
    }
}

impl std::str::FromStr for BlobId {
    type Err = InvalidId;

    fn from_str(s: &str) -> Result<Self, InvalidId> {
        if s.len() != ID_CHARS {
            return Err(InvalidId);
        }
        // The default engine rejects trailing-bit garbage, so only the canonical encoding of
        // each 16-byte value parses.
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
    fn roundtrip_and_truncation() {
        let id = BlobId::of(b"kurvengefahr");
        let s = id.to_string();
        assert_eq!(s.len(), ID_CHARS);
        assert_eq!(s.parse::<BlobId>().unwrap(), id);
        let full: [u8; 32] = Sha256::digest(b"kurvengefahr").into();
        assert_eq!(id.0, full[..ID_BYTES]);
        assert_eq!(BlobId::from_digest(&full), id);
    }

    #[test]
    fn rejects_malformed() {
        let good = BlobId::of(b"x").to_string();
        assert!(good[..ID_CHARS - 1].parse::<BlobId>().is_err(), "too short");
        assert!(format!("{good}A").parse::<BlobId>().is_err(), "too long");
        assert!(
            format!("+{}", &good[1..]).parse::<BlobId>().is_err(),
            "not url-safe"
        );
        assert!(
            format!("{}=", &good[..ID_CHARS - 1])
                .parse::<BlobId>()
                .is_err(),
            "padded"
        );
        // 22 chars decode to 132 bits; the final char's low 4 bits must be zero. "A…AB" sets
        // one of them — a non-canonical alias of the all-zero id, and must be rejected.
        let canonical = "A".repeat(ID_CHARS);
        assert_eq!(canonical.parse::<BlobId>().unwrap(), BlobId([0; ID_BYTES]));
        assert!(
            format!("{}B", "A".repeat(ID_CHARS - 1))
                .parse::<BlobId>()
                .is_err(),
            "trailing bits"
        );
    }
}
