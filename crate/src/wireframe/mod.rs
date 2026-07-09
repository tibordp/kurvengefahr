//! STL → wireframe line art. The one generator that consumes a 3D model: parse the STL (`stl`),
//! weld it into an indexed mesh and pick the **feature edges** — boundaries, creases above the
//! angle threshold, and view-dependent silhouettes, so a smooth surface draws as its outline
//! rather than triangle soup (`mesh`) — then project them through a turntable camera and, in
//! occluded mode, cut away the hidden parts with an image-space z-buffer (`view`).
//!
//! Like `raster`, output is element-local mm fit to the element's physical box, and the params
//! cross the boundary as one JSON blob whose schema this struct owns (see `src/elements/model`).
//! Deterministic per (bytes, params) — no randomness anywhere.

mod mesh;
mod stl;
mod view;

use serde::Deserialize;

use crate::geom::Stroke;

use mesh::Mesh;
use view::Camera;

/// Deserialized from the TS `ModelParams` (camelCase keys; unknown keys like `modelId` are
/// ignored, absent keys take the defaults below). The TS sanitizer applies the same clamps the
/// consumers here do, so out-of-range persisted values degrade identically on both sides.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Params {
    /// Physical box the wireframe is framed into (mm).
    #[serde(rename = "targetWidthMm")]
    pub target_w_mm: f32,
    #[serde(rename = "targetHeightMm")]
    pub target_h_mm: f32,
    /// Turntable camera: yaw around the model's Z (up) axis, pitch = elevation (deg, ±85).
    pub yaw: f32,
    pub pitch: f32,
    /// View offset in screen fractions (±0.5), applied post-projection.
    pub pan_x: f32,
    pub pan_y: f32,
    /// Camera dolly in units of the model's bounding radius (1.3..20). Perspective knob too.
    pub distance: f32,
    /// `"perspective"` | `"orthographic"`. Both frame the model identically at the center plane.
    pub projection: String,
    /// Remove hidden lines (vs. drawing the full transparent wireframe).
    pub occluded: bool,
    /// Edges whose faces meet at more than this dihedral angle (deg) are drawn.
    pub crease_angle: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            target_w_mm: 160.0,
            target_h_mm: 110.0,
            yaw: 30.0,
            pitch: 20.0,
            pan_x: 0.0,
            pan_y: 0.0,
            distance: 3.0,
            projection: "perspective".into(),
            occluded: true,
            crease_angle: 30.0,
        }
    }
}

/// STL bytes + JSON [`Params`] → wireframe strokes. Errors only on an unparseable STL; a
/// degenerate view (model off-screen, zero box) just yields fewer/no strokes.
pub fn generate(bytes: &[u8], params: &str) -> Result<Vec<Stroke>, String> {
    let p: Params = serde_json::from_str(params).unwrap_or_default();
    if p.target_w_mm <= 0.0 || p.target_h_mm <= 0.0 {
        return Ok(vec![]);
    }
    let mesh = Mesh::weld(&stl::parse(bytes)?);
    if mesh.tris.is_empty() {
        return Ok(vec![]);
    }
    let cam = Camera::new(&p, &mesh);
    let zbuf = if p.occluded { Some(view::zbuffer(&mesh, &cam)) } else { None };
    // Visibility bias: an edge lies exactly on its faces, so it must beat the z-buffer by a
    // model-scale margin; see `view` for the silhouette-safe reference depth.
    let bias = mesh.radius * 0.01;
    let cos_crease = p.crease_angle.clamp(1.0, 180.0).to_radians().cos();

    let mut out: Vec<Stroke> = Vec::new();
    for e in mesh::edges(&mesh) {
        let (va, vb) = (mesh.verts[e.a as usize], mesh.verts[e.b as usize]);
        let draw = if e.nfaces != 2 {
            true // boundary or non-manifold — always a real feature
        } else {
            let n1 = mesh.normals[e.faces[0] as usize];
            let n2 = mesh.normals[e.faces[1] as usize];
            let crease = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cos_crease;
            let mid = [(va[0] + vb[0]) / 2.0, (va[1] + vb[1]) / 2.0, (va[2] + vb[2]) / 2.0];
            crease || (cam.facing(n1, mid) != cam.facing(n2, mid))
        };
        if draw {
            view::edge_strokes(&cam, zbuf.as_ref(), va, vb, bias, &mut out);
        }
    }
    dedupe(&mut out);
    Ok(out)
}

/// Drop segments coincident with an earlier one (endpoints equal within 0.05 mm, either
/// direction). Meshes routinely produce them — e.g. a hidden edge lying exactly along a visible
/// silhouette edge passes the (deliberately generous) visibility test — and they'd plot as a
/// wasted second pen pass over the same line.
fn dedupe(strokes: &mut Vec<Stroke>) {
    let mut seen = std::collections::HashSet::new();
    strokes.retain(|s| {
        let q = |v: f32| (v * 20.0).round() as i32;
        let a = (q(s.points[0].x), q(s.points[0].y));
        let b = (q(s.points[s.points.len() - 1].x), q(s.points[s.points.len() - 1].y));
        seen.insert(if a <= b { (a, b) } else { (b, a) })
    });
}

/// Centered, stride-decimated triangle soup for the inspector's orbit preview: positions with the
/// full-mesh bbox center subtracted (so the TS camera frames exactly what [`generate`] renders),
/// the full-mesh bounding radius, and the undecimated triangle count.
pub fn preview(bytes: &[u8], max_tris: u32) -> Result<(Vec<f32>, f32, u32), String> {
    let mesh = Mesh::weld(&stl::parse(bytes)?);
    let total = mesh.tris.len() as u32;
    let stride = (total as usize).div_ceil(max_tris.max(1) as usize).max(1);
    let positions = mesh
        .tris
        .iter()
        .step_by(stride)
        .flat_map(|t| {
            let mut c = [0.0f32; 9];
            for (v, &i) in t.iter().enumerate() {
                for a in 0..3 {
                    c[v * 3 + a] = mesh.verts[i as usize][a] - mesh.center[a];
                }
            }
            c
        })
        .collect();
    Ok((positions, mesh.radius, total))
}

#[cfg(test)]
mod tests {
    use super::mesh::tests::cube_soup;
    use super::*;

    fn cube_stl() -> Vec<u8> {
        stl::to_binary(&cube_soup())
    }

    fn total_len(strokes: &[Stroke]) -> f32 {
        strokes
            .iter()
            .flat_map(|s| s.points.windows(2))
            .map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt())
            .sum()
    }

    #[test]
    fn transparent_cube_draws_its_12_crease_edges() {
        let json = r#"{"occluded": false, "yaw": 30, "pitch": 20}"#;
        let strokes = generate(&cube_stl(), json).unwrap();
        assert_eq!(strokes.len(), 12, "cube edges only, no face diagonals");
        let p = Params::default();
        for s in &strokes {
            assert_eq!(s.points.len(), 2);
            for pt in &s.points {
                assert!(pt.x >= -0.01 && pt.x <= p.target_w_mm + 0.01);
                assert!(pt.y >= -0.01 && pt.y <= p.target_h_mm + 0.01);
            }
        }
    }

    #[test]
    fn occluded_face_on_cube_is_just_the_front_square() {
        // Face-on, the front face hides everything else; the four connector edges recede
        // immediately behind it (perspective) or project to points (ortho).
        for proj in ["perspective", "orthographic"] {
            let json = format!(r#"{{"yaw": 0, "pitch": 0, "projection": "{proj}"}}"#);
            let strokes = generate(&cube_stl(), &json).unwrap();
            assert_eq!(strokes.len(), 4, "{proj}: expected the front square");
            // All four are full edges of one square: equal lengths.
            let len0 = total_len(&strokes[..1]);
            for s in &strokes {
                let l = total_len(std::slice::from_ref(s));
                assert!((l - len0).abs() < 0.1, "{proj}: square sides should match: {l} vs {len0}");
            }
        }
    }

    #[test]
    fn occlusion_only_removes_ink() {
        let transparent = generate(&cube_stl(), r#"{"occluded": false}"#).unwrap();
        let occluded = generate(&cube_stl(), r#"{"occluded": true}"#).unwrap();
        let (lt, lo) = (total_len(&transparent), total_len(&occluded));
        assert!(lo < lt - 5.0, "hidden lines should remove noticeable ink: {lo} vs {lt}");
        assert!(lo > lt * 0.3, "most silhouette ink survives: {lo} vs {lt}");
    }

    #[test]
    fn orthographic_keeps_parallels_parallel() {
        // Count near-vertical strokes sharing one exact direction: the cube's Z-verticals are
        // parallel in ortho (they converge under perspective).
        let json = r#"{"occluded": false, "projection": "orthographic"}"#;
        let dirs: Vec<f32> = generate(&cube_stl(), json)
            .unwrap()
            .iter()
            .map(|s| {
                let (a, b) = (&s.points[0], &s.points[1]);
                // Undirected angle from the vertical axis (stroke direction is arbitrary).
                let ang = (b.x - a.x).atan2(b.y - a.y).rem_euclid(std::f32::consts::PI);
                ang.min(std::f32::consts::PI - ang)
            })
            .filter(|d| *d < 0.3)
            .collect();
        assert!(dirs.len() >= 4, "expected the 4 near-vertical cube edges: {dirs:?}");
        let d0 = dirs[0];
        assert!(
            dirs.iter().filter(|d| (**d - d0).abs() < 1e-4).count() >= 4,
            "ortho verticals should be exactly parallel: {dirs:?}"
        );
    }

    #[test]
    fn deterministic_and_total() {
        let a = generate(&cube_stl(), "{}").unwrap();
        let b = generate(&cube_stl(), "{}").unwrap();
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            for (p, q) in x.points.iter().zip(&y.points) {
                assert_eq!((p.x, p.y), (q.x, q.y));
            }
        }
        assert!(generate(b"junk", "{}").is_err());
        assert!(!generate(&cube_stl(), "not json").unwrap().is_empty());
    }

    #[test]
    fn preview_centers_and_decimates() {
        let (pos, radius, total) = preview(&cube_stl(), 4).unwrap();
        assert_eq!(total, 12);
        let kept = pos.len() / 9;
        assert!((3..=4).contains(&kept), "stride decimation kept {kept}");
        assert!((radius - 3.0f32.sqrt()).abs() < 1e-5);
        assert!(pos.iter().all(|v| v.abs() <= 1.0 + 1e-5), "positions should be centered");
    }
}
