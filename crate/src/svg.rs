//! SVG import → native multi-contour geometry. Parsing, transform resolution and curve flattening
//! are done by usvg (no text/font features — text nodes are skipped); occlusion is real polygon
//! boolean (i_overlay), subtracting upper filled shapes from those beneath so only the visible part
//! of each becomes geometry. The result crosses the WASM boundary as CSR rings grouped per output
//! shape, with each shape's source colour + fill darkness, so the TS side builds `path` elements
//! (nearest-palette pen, hatch density from darkness). A pen plotter has no solid fill, so a filled
//! region imports as a closed shape (the app hatches it); a stroked path imports as its centreline.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use usvg::tiny_skia_path::PathSegment;
use wasm_bindgen::prelude::*;

type P = [f32; 2];
type Ring = Vec<P>;
type Contours = Vec<Ring>;

/// Flatten tolerance in mm (post-scale): max chord deviation when flattening Béziers.
const TOL: f32 = 0.15;

#[derive(serde::Deserialize)]
#[serde(default)]
struct Params {
    /// Subtract upper filled shapes from those beneath (paint order) so hidden areas don't plot.
    occlude: bool,
    /// Longest side, in mm, to scale the SVG into. `<= 0` keeps the SVG's user units as mm.
    target_size: f32,
}
impl Default for Params {
    fn default() -> Self {
        Self { occlude: true, target_size: 200.0 }
    }
}

/// A flattened source shape (one usvg `Path`), in mm, with its paint.
struct Shape {
    /// Subpaths as polylines, with whether each was explicitly closed (for stroke centrelines).
    subpaths: Vec<(Ring, bool)>,
    /// (packed 0xRRGGBB, darkness 0..1) when the path has a fill.
    fill: Option<(u32, f32)>,
    /// Packed 0xRRGGBB when the path has a stroke.
    stroke: Option<u32>,
}

fn mid(a: P, b: P) -> P {
    [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5]
}

fn dist_pt_line(p: P, a: P, b: P) -> f32 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-9 {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx).abs() / len
}

fn flatten_cubic(p0: P, p1: P, p2: P, p3: P, depth: u8, out: &mut Ring) {
    if depth >= 18 || (dist_pt_line(p1, p0, p3) <= TOL && dist_pt_line(p2, p0, p3) <= TOL) {
        out.push(p3);
        return;
    }
    let p01 = mid(p0, p1);
    let p12 = mid(p1, p2);
    let p23 = mid(p2, p3);
    let p012 = mid(p01, p12);
    let p123 = mid(p12, p23);
    let p0123 = mid(p012, p123);
    flatten_cubic(p0, p01, p012, p0123, depth + 1, out);
    flatten_cubic(p0123, p123, p23, p3, depth + 1, out);
}

fn flatten_quad(p0: P, p1: P, p2: P, depth: u8, out: &mut Ring) {
    if depth >= 18 || dist_pt_line(p1, p0, p2) <= TOL {
        out.push(p2);
        return;
    }
    let p01 = mid(p0, p1);
    let p12 = mid(p1, p2);
    let p012 = mid(p01, p12);
    flatten_quad(p0, p01, p012, depth + 1, out);
    flatten_quad(p012, p12, p2, depth + 1, out);
}

/// Flatten one usvg path to mm-space subpaths, applying its absolute transform then `scale`.
fn flatten(path: &usvg::Path, scale: f32) -> Vec<(Ring, bool)> {
    let t = path.abs_transform();
    let map = |p: usvg::tiny_skia_path::Point| -> P {
        [(p.x * t.sx + p.y * t.kx + t.tx) * scale, (p.x * t.ky + p.y * t.sy + t.ty) * scale]
    };
    let mut out: Vec<(Ring, bool)> = Vec::new();
    let mut cur: Ring = Vec::new();
    let mut last: P = [0.0, 0.0];
    let flush = |cur: &mut Ring, out: &mut Vec<(Ring, bool)>, closed: bool| {
        if cur.len() >= 2 {
            out.push((std::mem::take(cur), closed));
        } else {
            cur.clear();
        }
    };
    for seg in path.data().segments() {
        match seg {
            PathSegment::MoveTo(p) => {
                flush(&mut cur, &mut out, false);
                last = map(p);
                cur.push(last);
            }
            PathSegment::LineTo(p) => {
                last = map(p);
                cur.push(last);
            }
            PathSegment::QuadTo(p1, p) => {
                let (c1, e) = (map(p1), map(p));
                flatten_quad(last, c1, e, 0, &mut cur);
                last = e;
            }
            PathSegment::CubicTo(p1, p2, p) => {
                let (c1, c2, e) = (map(p1), map(p2), map(p));
                flatten_cubic(last, c1, c2, e, 0, &mut cur);
                last = e;
            }
            PathSegment::Close => flush(&mut cur, &mut out, true),
        }
    }
    flush(&mut cur, &mut out, false);
    out
}

fn paint_rgb(paint: &usvg::Paint) -> u32 {
    match paint {
        usvg::Paint::Color(c) => ((c.red as u32) << 16) | ((c.green as u32) << 8) | c.blue as u32,
        _ => 0x808080, // gradient / pattern: no gradients on a plotter — treat as mid grey
    }
}

/// Perceptual darkness 0..1 (1 = black), scaled by paint opacity (more transparent ⇒ lighter).
fn darkness(rgb: u32, opacity: f32) -> f32 {
    let r = ((rgb >> 16) & 0xff) as f32;
    let g = ((rgb >> 8) & 0xff) as f32;
    let b = (rgb & 0xff) as f32;
    let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
    ((1.0 - lum) * opacity).clamp(0.0, 1.0)
}

fn collect(group: &usvg::Group, scale: f32, shapes: &mut Vec<Shape>) {
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => collect(g, scale, shapes),
            usvg::Node::Path(p) => {
                if !p.is_visible() {
                    continue;
                }
                let subpaths = flatten(p, scale);
                if subpaths.is_empty() {
                    continue;
                }
                let fill = p.fill().map(|f| {
                    let rgb = paint_rgb(f.paint());
                    (rgb, darkness(rgb, f.opacity().get()))
                });
                let stroke = p.stroke().map(|s| paint_rgb(s.paint()));
                shapes.push(Shape { subpaths, fill, stroke });
            }
            _ => {} // Image / Text (no text feature) are ignored
        }
    }
}

fn boolean(subj: &Contours, clip: &Contours, rule: OverlayRule) -> Contours {
    subj.overlay(clip, rule, FillRule::NonZero).into_iter().flatten().collect()
}

/// CSR output: rings grouped per output shape, each shape carrying its source colour/darkness/kind.
struct Out {
    xy: Vec<f32>,
    ring_starts: Vec<u32>,
    ring_closed: Vec<u8>,
    shape_starts: Vec<u32>,
    colors: Vec<u32>,
    darkness: Vec<f32>,
    kind: Vec<u8>, // 0 = filled region, 1 = stroke centreline
}
impl Out {
    fn new() -> Self {
        Self {
            xy: Vec::new(),
            ring_starts: vec![0],
            ring_closed: Vec::new(),
            shape_starts: vec![0],
            colors: Vec::new(),
            darkness: Vec::new(),
            kind: Vec::new(),
        }
    }
    fn ring(&mut self, r: &Ring, closed: bool) {
        if r.len() < 2 {
            return;
        }
        for p in r {
            self.xy.push(p[0]);
            self.xy.push(p[1]);
        }
        self.ring_starts.push((self.xy.len() / 2) as u32);
        self.ring_closed.push(closed as u8);
    }
    /// Close out a shape if it added any rings since the last one.
    fn shape(&mut self, rgb: u32, dark: f32, kind: u8) {
        let rings = (self.ring_starts.len() - 1) as u32;
        if *self.shape_starts.last().unwrap() == rings {
            return; // no rings added — skip empty shape
        }
        self.shape_starts.push(rings);
        self.colors.push(rgb);
        self.darkness.push(dark);
        self.kind.push(kind);
    }
}

/// Parse + flatten + (optionally) occlude an SVG, producing per-shape multi-contour geometry.
pub fn import(bytes: &[u8], params_json: &str) -> SvgImport {
    let params: Params = serde_json::from_str(params_json).unwrap_or_default();
    let tree = match usvg::Tree::from_data(bytes, &usvg::Options::default()) {
        Ok(t) => t,
        Err(_) => return SvgImport { inner: Out::new() },
    };
    let size = tree.size();
    let scale = if params.target_size > 0.0 {
        params.target_size / size.width().max(size.height()).max(1e-3)
    } else {
        1.0
    };

    let mut shapes: Vec<Shape> = Vec::new();
    collect(tree.root(), scale, &mut shapes);

    // Each filled shape's fill rings (subpaths), and the visible part after occlusion.
    let fills: Vec<Contours> = shapes
        .iter()
        .map(|s| match s.fill {
            Some(_) => s.subpaths.iter().map(|(r, _)| r.clone()).collect(),
            None => Vec::new(),
        })
        .collect();
    let mut visible = fills.clone();
    if params.occlude {
        // Walk top → bottom, subtracting everything painted above from each shape.
        let mut covered: Contours = Vec::new();
        for i in (0..shapes.len()).rev() {
            if fills[i].is_empty() {
                continue;
            }
            visible[i] = if covered.is_empty() {
                fills[i].clone()
            } else {
                boolean(&fills[i], &covered, OverlayRule::Difference)
            };
            covered = if covered.is_empty() {
                fills[i].clone()
            } else {
                boolean(&covered, &fills[i], OverlayRule::Union)
            };
        }
    }

    let mut out = Out::new();
    for (i, s) in shapes.iter().enumerate() {
        if let Some((rgb, dark)) = s.fill {
            for r in &visible[i] {
                out.ring(r, true);
            }
            out.shape(rgb, dark, 0);
        }
        if let Some(rgb) = s.stroke {
            for (r, closed) in &s.subpaths {
                out.ring(r, *closed);
            }
            out.shape(rgb, 0.0, 1);
        }
    }
    SvgImport { inner: out }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Two overlapping black-filled squares; the second is painted on top of the first.
    const SVG: &[u8] = br#"<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <rect width="60" height="60" fill="black"/>
        <rect x="40" y="40" width="60" height="60" fill="black"/></svg>"#;

    #[test]
    fn imports_two_filled_shapes() {
        let r = import(SVG, "{\"occlude\":false,\"target_size\":100}");
        assert_eq!(r.inner.colors.len(), 2, "two filled rects → two shapes");
        assert!(r.inner.kind.iter().all(|&k| k == 0), "both are fills");
        assert!(r.inner.darkness.iter().all(|&d| d > 0.99), "black ⇒ darkness ~1");
    }

    #[test]
    fn occlusion_clips_the_lower_shape() {
        let full = import(SVG, "{\"occlude\":false,\"target_size\":100}");
        let occ = import(SVG, "{\"occlude\":true,\"target_size\":100}");
        assert_eq!(occ.inner.colors.len(), 2, "both shapes survive (lower just shrinks)");
        // The lower square loses its covered corner → an L with more vertices than the plain rects.
        assert!(occ.inner.xy.len() > full.inner.xy.len(), "occluded lower shape has more vertices");
    }

    #[test]
    fn stroke_only_path_imports_as_centreline() {
        let svg = br#"<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 10 L90 10 L90 90" fill="none" stroke="red"/></svg>"#;
        let r = import(svg, "{\"occlude\":true,\"target_size\":100}");
        assert_eq!(r.inner.kind, vec![1], "stroke, no fill → one stroke shape");
        assert_eq!(r.inner.ring_closed, vec![0], "open centreline");
    }
}

/// WASM handle for an import result. CSR layout: `ring_starts` (point units) slices `xy` into rings;
/// `shape_starts` slices the rings into shapes; `colors`/`darkness`/`kind` are one-per-shape.
#[wasm_bindgen]
pub struct SvgImport {
    inner: Out,
}

#[wasm_bindgen]
impl SvgImport {
    #[wasm_bindgen(getter)]
    pub fn xy(&self) -> Vec<f32> {
        self.inner.xy.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn ring_starts(&self) -> Vec<u32> {
        self.inner.ring_starts.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn ring_closed(&self) -> Vec<u8> {
        self.inner.ring_closed.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn shape_starts(&self) -> Vec<u32> {
        self.inner.shape_starts.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn colors(&self) -> Vec<u32> {
        self.inner.colors.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn darkness(&self) -> Vec<f32> {
        self.inner.darkness.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> Vec<u8> {
        self.inner.kind.clone()
    }
}
