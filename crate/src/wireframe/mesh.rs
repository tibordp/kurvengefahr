//! Triangle soup → indexed mesh + feature edges.
//!
//! STL duplicates every shared vertex, so edges only become findable after welding (exact f32
//! bit equality — STL exporters emit shared vertices verbatim; a tolerance weld would need
//! spatial hashing for no practical gain, and a mesh with real cracks just shows a few extra
//! boundary edges). Vertex indices follow first-encounter order and the edge list is sorted, so
//! output is deterministic (a HashMap is used only for lookup, never iterated).

use std::collections::HashMap;

pub struct Mesh {
    pub verts: Vec<[f32; 3]>,
    pub tris: Vec<[u32; 3]>,
    /// Per-face unit normals (degenerate faces get a zero normal and never classify as creases).
    pub normals: Vec<[f32; 3]>,
    pub center: [f32; 3],
    /// Bounding-box half-diagonal — a safe bound on every vertex's distance from `center`.
    pub radius: f32,
}

impl Mesh {
    pub fn weld(soup: &[f32]) -> Mesh {
        let mut lookup: HashMap<[u32; 3], u32> = HashMap::new();
        let mut verts: Vec<[f32; 3]> = Vec::new();
        let mut tris: Vec<[u32; 3]> = Vec::new();
        for t in soup.chunks_exact(9) {
            let mut idx = [0u32; 3];
            for v in 0..3 {
                let p = [t[v * 3], t[v * 3 + 1], t[v * 3 + 2]];
                let key = [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()];
                idx[v] = *lookup.entry(key).or_insert_with(|| {
                    verts.push(p);
                    (verts.len() - 1) as u32
                });
            }
            if idx[0] != idx[1] && idx[1] != idx[2] && idx[0] != idx[2] {
                tris.push(idx);
            }
        }

        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for v in &verts {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
        let (center, radius) = if verts.is_empty() {
            ([0.0; 3], 1.0)
        } else {
            let d = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            (
                [
                    (lo[0] + hi[0]) / 2.0,
                    (lo[1] + hi[1]) / 2.0,
                    (lo[2] + hi[2]) / 2.0,
                ],
                ((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() / 2.0).max(1e-6),
            )
        };

        let normals = tris
            .iter()
            .map(|t| {
                let (a, b, c) = (
                    verts[t[0] as usize],
                    verts[t[1] as usize],
                    verts[t[2] as usize],
                );
                let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let n = [
                    u[1] * v[2] - u[2] * v[1],
                    u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0],
                ];
                let l = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
                if l < 1e-12 {
                    [0.0; 3]
                } else {
                    [n[0] / l, n[1] / l, n[2] / l]
                }
            })
            .collect();

        Mesh {
            verts,
            tris,
            normals,
            center,
            radius,
        }
    }
}

/// A unique undirected mesh edge with its (up to two) adjacent faces. Non-manifold extras beyond
/// the second face are ignored — such edges classify as always-drawn anyway.
pub struct Edge {
    pub a: u32,
    pub b: u32,
    pub faces: [u32; 2],
    pub nfaces: u8,
}

pub fn edges(mesh: &Mesh) -> Vec<Edge> {
    let mut map: HashMap<(u32, u32), Edge> = HashMap::new();
    for (f, t) in mesh.tris.iter().enumerate() {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let key = (a.min(b), a.max(b));
            let e = map.entry(key).or_insert(Edge {
                a: key.0,
                b: key.1,
                faces: [0; 2],
                nfaces: 0,
            });
            if e.nfaces < 2 {
                e.faces[e.nfaces as usize] = f as u32;
            }
            e.nfaces = e.nfaces.saturating_add(1);
        }
    }
    let mut out: Vec<Edge> = map.into_values().collect();
    out.sort_by_key(|e| (e.a, e.b));
    out
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    /// A 2-unit cube as 12 soup triangles.
    pub(crate) fn cube_soup() -> Vec<f32> {
        let v = |mask: u8| {
            [
                if mask & 1 != 0 { 1.0 } else { -1.0f32 },
                if mask & 2 != 0 { 1.0 } else { -1.0 },
                if mask & 4 != 0 { 1.0 } else { -1.0 },
            ]
        };
        let mut soup = Vec::new();
        for quad in [
            [0, 1, 3, 2],
            [4, 6, 7, 5],
            [0, 4, 5, 1],
            [2, 3, 7, 6],
            [0, 2, 6, 4],
            [1, 5, 7, 3],
        ] {
            for t in [[0, 1, 2], [0, 2, 3]] {
                for i in t {
                    soup.extend_from_slice(&v(quad[i]));
                }
            }
        }
        soup
    }

    #[test]
    fn cube_welds_to_8_verts_18_edges() {
        let mesh = Mesh::weld(&cube_soup());
        assert_eq!(mesh.verts.len(), 8);
        assert_eq!(mesh.tris.len(), 12);
        assert!((mesh.radius - 3.0f32.sqrt()).abs() < 1e-6);
        let es = edges(&mesh);
        assert_eq!(es.len(), 18); // 12 cube edges + 6 face diagonals
        assert!(es.iter().all(|e| e.nfaces == 2), "closed cube is manifold");
    }

    #[test]
    fn cube_creases_are_the_12_cube_edges() {
        let mesh = Mesh::weld(&cube_soup());
        let cos30 = 30.0f32.to_radians().cos();
        let creases = edges(&mesh)
            .iter()
            .filter(|e| {
                let (n1, n2) = (
                    mesh.normals[e.faces[0] as usize],
                    mesh.normals[e.faces[1] as usize],
                );
                n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cos30
            })
            .count();
        assert_eq!(creases, 12); // the 6 in-plane diagonals don't crease
    }

    #[test]
    fn open_quad_has_boundary_edges() {
        let soup = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let mesh = Mesh::weld(&soup);
        let es = edges(&mesh);
        assert_eq!(es.len(), 5);
        assert_eq!(es.iter().filter(|e| e.nfaces == 1).count(), 4);
    }
}
