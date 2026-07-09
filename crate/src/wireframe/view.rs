//! Camera, z-buffer, and image-space hidden-line removal.
//!
//! The camera is the same Z-up turntable as the inspector's orbit preview (yaw around Z, pitch =
//! elevation clamped ±85°, pan as a post-projection screen offset, `distance` in bounding radii —
//! keep the math in lockstep with `OrbitPreview.tsx`). `distance ≥ 1.3 × radius` keeps every
//! vertex strictly in front of the eye, so no near-plane clipping exists anywhere. Orthographic
//! mode scales by the frustum height at the model's center, so toggling projections holds the
//! apparent size and only drops the foreshortening.
//!
//! Hidden-line removal is image-space: rasterize an eye-depth z-buffer, then walk each projected
//! edge and keep the runs whose depth reaches the surface. The reference depth is the *farthest*
//! of the sample's 3×3 neighborhood plus a distance-scaled bias — an edge lies exactly ON its
//! faces, and at silhouettes the surface depth swings wildly within one pixel, so a naive point
//! compare eats the very edges that matter. The cost is ~a pixel of leakage behind silhouettes,
//! invisible at plot scale. Visible runs are cleaned morphologically (bridge sub-sample hidden
//! gaps, drop dust) and clipped to the element box.

use crate::geom::{Point, Stroke};
use crate::tess::{WIREFRAME_FOV_DEG, WIREFRAME_HLR_RES, WIREFRAME_SAMPLE_STEP};

use super::mesh::Mesh;
use super::Params;

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt().max(1e-12);
    [a[0] / l, a[1] / l, a[2] / l]
}

pub struct Camera {
    pub eye: V3,
    fwd: V3,
    right: V3,
    up: V3,
    ortho: bool,
    /// Perspective: tan(fov/2). Orthographic: frustum half-height at the model center (mm-in-NDC
    /// scale), chosen so both projections frame the model identically.
    tanf: f32,
    half_h: f32,
    aspect: f32,
    pan_x: f32,
    pan_y: f32,
    tw: f32,
    th: f32,
}

impl Camera {
    pub fn new(p: &Params, mesh: &Mesh) -> Camera {
        let yaw = p.yaw.to_radians();
        let pitch = p.pitch.clamp(-85.0, 85.0).to_radians();
        let d = p.distance.clamp(1.3, 20.0) * mesh.radius;
        // Eye direction (from center toward the eye); yaw 0 / pitch 0 looks at the -Y face.
        let e: V3 = [yaw.sin() * pitch.cos(), -yaw.cos() * pitch.cos(), pitch.sin()];
        let eye: V3 = [
            mesh.center[0] + d * e[0],
            mesh.center[1] + d * e[1],
            mesh.center[2] + d * e[2],
        ];
        let fwd: V3 = [-e[0], -e[1], -e[2]];
        let right = norm(cross(fwd, [0.0, 0.0, 1.0]));
        let up = cross(right, fwd);
        let tanf = (WIREFRAME_FOV_DEG.to_radians() / 2.0).tan();
        Camera {
            eye,
            fwd,
            right,
            up,
            ortho: p.projection == "orthographic",
            tanf,
            half_h: tanf * d,
            aspect: p.target_w_mm / p.target_h_mm,
            pan_x: p.pan_x,
            pan_y: p.pan_y,
            tw: p.target_w_mm,
            th: p.target_h_mm,
        }
    }

    /// Model space → (x mm, y mm, eye depth). The mm point may lie outside the element box —
    /// callers clip.
    pub fn project(&self, v: V3) -> [f32; 3] {
        let rel = sub(v, self.eye);
        let z = dot(rel, self.fwd);
        let (sx, sy) = if self.ortho {
            (dot(rel, self.right) / self.half_h, dot(rel, self.up) / self.half_h)
        } else {
            (dot(rel, self.right) / (z * self.tanf), dot(rel, self.up) / (z * self.tanf))
        };
        let ndc_x = sx / self.aspect + 2.0 * self.pan_x;
        let ndc_y = sy - 2.0 * self.pan_y;
        [(ndc_x * 0.5 + 0.5) * self.tw, (0.5 - ndc_y * 0.5) * self.th, z]
    }

    /// Whether a face points toward the eye (for silhouette classification). `at` is any point
    /// on the face — under perspective, facing depends on the viewing ray, not just the normal.
    pub fn facing(&self, normal: V3, at: V3) -> bool {
        if self.ortho {
            dot(normal, self.fwd) < 0.0
        } else {
            dot(normal, sub(at, self.eye)) < 0.0
        }
    }
}

/// Eye-depth buffer over the element box (`f32::INFINITY` = background).
pub struct ZBuffer {
    w: usize,
    h: usize,
    res: f32,
    data: Vec<f32>,
}

pub fn zbuffer(mesh: &Mesh, cam: &Camera) -> ZBuffer {
    let w = ((cam.tw * WIREFRAME_HLR_RES).ceil() as usize).clamp(1, 4096);
    let h = ((cam.th * WIREFRAME_HLR_RES).ceil() as usize).clamp(1, 4096);
    let res = w as f32 / cam.tw;
    let mut data = vec![f32::INFINITY; w * h];

    for t in &mesh.tris {
        let pv = |i: u32| {
            let p = cam.project(mesh.verts[i as usize]);
            [p[0] * res, p[1] * res, p[2]]
        };
        let (a, b, c) = (pv(t[0]), pv(t[1]), pv(t[2]));
        let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if area.abs() < 1e-12 {
            continue;
        }
        // Interpolate what's affine in screen space: 1/z under perspective, z under ortho.
        let dv = |z: f32| if cam.ortho { z } else { 1.0 / z };
        let (da, db, dc) = (dv(a[2]), dv(b[2]), dv(c[2]));
        let x0 = a[0].min(b[0]).min(c[0]).floor().max(0.0) as usize;
        let x1 = (a[0].max(b[0]).max(c[0]).ceil() as isize).clamp(0, w as isize) as usize;
        let y0 = a[1].min(b[1]).min(c[1]).floor().max(0.0) as usize;
        let y1 = (a[1].max(b[1]).max(c[1]).ceil() as isize).clamp(0, h as isize) as usize;
        for py in y0..y1 {
            let sy = py as f32 + 0.5;
            for px in x0..x1 {
                let sx = px as f32 + 0.5;
                let w0 = (b[0] - a[0]) * (sy - a[1]) - (b[1] - a[1]) * (sx - a[0]);
                let w1 = (c[0] - b[0]) * (sy - b[1]) - (c[1] - b[1]) * (sx - b[0]);
                let w2 = (a[0] - c[0]) * (sy - c[1]) - (a[1] - c[1]) * (sx - c[0]);
                let inside = if area > 0.0 {
                    w0 >= 0.0 && w1 >= 0.0 && w2 >= 0.0
                } else {
                    w0 <= 0.0 && w1 <= 0.0 && w2 <= 0.0
                };
                if !inside {
                    continue;
                }
                let d = (w1 * da + w2 * db + w0 * dc) / area;
                let z = if cam.ortho { d } else { 1.0 / d };
                let cell = &mut data[py * w + px];
                if z < *cell {
                    *cell = z;
                }
            }
        }
    }
    ZBuffer { w, h, res, data }
}

impl ZBuffer {
    /// The *farthest* depth in the 3×3 neighborhood of an mm point — the generous visibility
    /// reference (see module header). Off-grid → background.
    fn reference(&self, x_mm: f32, y_mm: f32) -> f32 {
        let cx = (x_mm * self.res) as isize;
        let cy = (y_mm * self.res) as isize;
        let mut zmax = f32::NEG_INFINITY;
        for dy in -1..=1isize {
            for dx in -1..=1isize {
                let (x, y) = (cx + dx, cy + dy);
                if x < 0 || y < 0 || x >= self.w as isize || y >= self.h as isize {
                    zmax = f32::INFINITY;
                } else {
                    zmax = zmax.max(self.data[y as usize * self.w + x as usize]);
                }
            }
        }
        zmax
    }
}

/// One mesh edge → its visible sub-segments as strokes (or the whole edge when `zbuf` is None,
/// i.e. transparent mode). Everything is clipped to the element box.
pub fn edge_strokes(
    cam: &Camera,
    zbuf: Option<&ZBuffer>,
    a: V3,
    b: V3,
    bias: f32,
    out: &mut Vec<Stroke>,
) {
    let pa = cam.project(a);
    let pb = cam.project(b);
    let Some(zbuf) = zbuf else {
        push_clipped(out, [pa[0], pa[1]], [pb[0], pb[1]], cam.tw, cam.th);
        return;
    };

    let len = ((pb[0] - pa[0]).powi(2) + (pb[1] - pa[1]).powi(2)).sqrt();
    let n = ((len / WIREFRAME_SAMPLE_STEP).ceil() as usize).clamp(1, 4096);
    let mut vis = vec![false; n + 1];
    for (i, v) in vis.iter_mut().enumerate() {
        let t = i as f32 / n as f32;
        // Interpolate in 3D and project — screen-space lerp would be wrong under perspective.
        let p = cam.project([
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
        ]);
        *v = p[2] <= zbuf.reference(p[0], p[1]) + bias;
    }
    // Bridge sub-sample hidden gaps (z-buffer stitching noise), then drop visible dust.
    morph_filter(&mut vis, false, 2);
    morph_filter(&mut vis, true, 2);

    let mut run = None::<usize>;
    for i in 0..=n + 1 {
        match (run, i <= n && vis[i]) {
            (None, true) => run = Some(i),
            (Some(s), false) => {
                let seg = |j: usize| {
                    let t = j as f32 / n as f32;
                    [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t]
                };
                push_clipped(out, seg(s), seg(i - 1), cam.tw, cam.th);
                run = None;
            }
            _ => {}
        }
    }
}

/// Flip runs of `value` shorter than `min_len` (in samples).
fn morph_filter(vis: &mut [bool], value: bool, min_len: usize) {
    let n = vis.len();
    let mut i = 0;
    while i < n {
        if vis[i] == value {
            let start = i;
            while i < n && vis[i] == value {
                i += 1;
            }
            // Runs touching either end survive — they may continue on an adjacent edge.
            if i - start < min_len && start > 0 && i < n {
                vis[start..i].iter_mut().for_each(|v| *v = !value);
            }
        } else {
            i += 1;
        }
    }
}

/// Liang-Barsky clip of one segment to the element box; emits a stroke if anything remains.
fn push_clipped(out: &mut Vec<Stroke>, a: [f32; 2], b: [f32; 2], tw: f32, th: f32) {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let mut t0 = 0.0f32;
    let mut t1 = 1.0f32;
    for (p, q) in [
        (-dx, a[0]),
        (dx, tw - a[0]),
        (-dy, a[1]),
        (dy, th - a[1]),
    ] {
        if p.abs() < 1e-12 {
            if q < 0.0 {
                return;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                t0 = t0.max(r);
            } else {
                t1 = t1.min(r);
            }
        }
    }
    if t0 >= t1 {
        return;
    }
    let pt = |t: f32| Point { x: a[0] + dx * t, y: a[1] + dy * t, pressure: 1.0 };
    let (p0, p1) = (pt(t0), pt(t1));
    if (p1.x - p0.x).abs() < 1e-3 && (p1.y - p0.y).abs() < 1e-3 {
        return;
    }
    out.push(Stroke { points: vec![p0, p1], pen: 0, reversible: true, group: 0 });
}
