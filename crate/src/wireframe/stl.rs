//! STL parsing: raw file bytes → flat triangle soup (9 f32 per triangle, model units).
//!
//! Both encodings, hand-rolled (the format is trivial; no dependency warranted). Binary is
//! detected by the exact size identity `len == 84 + 50·tri_count` — the only robust test, since
//! real-world binary files sometimes begin with the ASCII marker `solid`. Files that fail the
//! identity but start with `solid` parse as ASCII; anything else is rejected.

/// Parse an STL file into flat triangle positions (`[x0,y0,z0, x1,y1,z1, x2,y2,z2]` per
/// triangle). Normals and binary attribute bytes are ignored (we recompute normals where needed).
pub fn parse(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if let Some(tris) = parse_binary(bytes) {
        return Ok(tris);
    }
    if bytes.len() >= 5 && bytes[..5].eq_ignore_ascii_case(b"solid") {
        return parse_ascii(bytes);
    }
    Err("not a recognizable STL file".into())
}

/// Binary layout: 80-byte header, LE u32 triangle count, then 50 bytes per triangle
/// (normal 12B + three vertices 12B each + attribute u16). Returns None if the size identity
/// doesn't hold (→ try ASCII).
fn parse_binary(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() < 84 {
        return None;
    }
    let count = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as u64;
    if count == 0 || bytes.len() as u64 != 84 + 50 * count {
        return None;
    }
    let count = count as usize;
    let mut tris = Vec::with_capacity(count * 9);
    for i in 0..count {
        let rec = 84 + i * 50 + 12; // skip the normal
        for v in 0..9 {
            let at = rec + v * 4;
            tris.push(f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()));
        }
    }
    Some(tris)
}

/// ASCII: scan for `vertex x y z` triples; every three vertices form one triangle. Tolerant of
/// malformed trailing data — errors only if no complete triangle was found.
fn parse_ascii(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let text = String::from_utf8_lossy(bytes);
    let mut coords: Vec<f32> = Vec::new();
    let mut tokens = text.split_ascii_whitespace();
    while let Some(tok) = tokens.next() {
        if !tok.eq_ignore_ascii_case("vertex") {
            continue;
        }
        for _ in 0..3 {
            let Some(v) = tokens.next().and_then(|t| t.parse::<f32>().ok()) else {
                return Err("malformed ASCII STL vertex".into());
            };
            coords.push(v);
        }
    }
    coords.truncate(coords.len() / 9 * 9);
    if coords.is_empty() {
        return Err("STL contains no triangles".into());
    }
    Ok(coords)
}

#[cfg(test)]
pub(super) fn to_binary(tris: &[f32]) -> Vec<u8> {
    let count = tris.len() / 9;
    let mut out = vec![0u8; 80];
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for t in 0..count {
        out.extend_from_slice(&[0u8; 12]); // normal
        for v in 0..9 {
            out.extend_from_slice(&tris[t * 9 + v].to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 2]); // attribute
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_round_trips() {
        let tris = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0,
        ];
        let parsed = parse(&to_binary(&tris)).unwrap();
        assert_eq!(parsed, tris);
    }

    #[test]
    fn binary_starting_with_solid_parses_as_binary() {
        let tris = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let mut bytes = to_binary(&tris);
        bytes[..6].copy_from_slice(b"solid "); // pathological but real-world header
        assert_eq!(parse(&bytes).unwrap(), tris);
    }

    #[test]
    fn ascii_tetrahedron_parses() {
        let src = "solid tet
          facet normal 0 0 1
            outer loop
              vertex 0 0 0
              vertex 1 0 0
              vertex 0 1 0
            endloop
          endfacet
          facet normal 0 0 1
            outer loop
              vertex 0 0 0
              vertex 0 1 0
              vertex 0 0 1
            endloop
          endfacet
        endsolid tet";
        let tris = parse(src.as_bytes()).unwrap();
        assert_eq!(tris.len(), 18);
        assert_eq!(&tris[..3], &[0.0, 0.0, 0.0]);
        assert_eq!(&tris[15..18], &[0.0, 0.0, 1.0]);
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse(b"not an stl at all").is_err());
        assert!(parse(b"").is_err());
        assert!(parse(b"solid empty\nendsolid empty").is_err());
    }
}
