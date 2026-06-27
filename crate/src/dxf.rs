//! DXF import: a small hand-rolled parser for ASCII DXF, flattening entities to polyline contours
//! and mirroring `svg.rs`'s output shape so the TS side builds `path` elements the same way. DXF is
//! line art (no fills), so every entity becomes one open/closed contour carrying a colour (entity
//! ACI 62, else its layer's). DXF carries real dimensions, so we import at actual size (mm = coord ×
//! `unit_scale`, the caller's chosen unit, defaulting to the sniffed `$INSUNITS`) and Y-flip (DXF is
//! Y-up, our page is Y-down); TS centres on the bed. Curves (arcs, circles, ellipses, polyline
//! bulges, splines) are flattened here. Text, blocks (INSERT) and hatches are not imported.
//!
//! DXF is a flat stream of (group-code, value) line pairs. We pair them, split into records at each
//! code-0 (a record = an entity/table entry + its fields), then walk records by section. A
//! hand-rolled parser keeps it tiny (the `dxf` crate adds ~600 KB of WASM + a uuid/getrandom hack).
use std::collections::HashMap;
use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

#[derive(serde::Deserialize)]
#[serde(default)]
struct Params {
    /// Millimetres per DXF unit. DXF carries real dimensions, so we import at actual size; the caller
    /// picks the unit (defaulting to the sniffed `$INSUNITS`).
    unit_scale: f32,
    /// Chain open segments that share endpoints into polylines (CAD often exports thousands of loose
    /// LINEs); without this a drawing becomes thousands of one-segment elements.
    merge: bool,
}
impl Default for Params {
    fn default() -> Self {
        Self { unit_scale: 1.0, merge: true }
    }
}

type Ring = Vec<(f64, f64)>;

#[derive(Default)]
struct Out {
    xy: Vec<f32>,
    ring_starts: Vec<u32>,
    ring_closed: Vec<u8>,
    shape_starts: Vec<u32>,
    colors: Vec<u32>,
    /// The `$INSUNITS` header value (0 = unitless, 1 = inch, 4 = mm, …), so the dialog can default
    /// the unit selector. 0 if absent.
    insunits: u32,
}

#[wasm_bindgen]
pub struct DxfImport {
    inner: Out,
}

#[wasm_bindgen]
impl DxfImport {
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
    pub fn insunits(&self) -> u32 {
        self.inner.insunits
    }
}

// ---- parsing -----------------------------------------------------------------------------------

struct Rec {
    typ: String,
    fields: Vec<(i32, String)>,
}
impl Rec {
    fn f(&self, code: i32) -> f64 {
        self.fields.iter().find(|(c, _)| *c == code).and_then(|(_, v)| v.parse().ok()).unwrap_or(0.0)
    }
    fn i(&self, code: i32) -> i32 {
        self.fields.iter().find(|(c, _)| *c == code).and_then(|(_, v)| v.parse().ok()).unwrap_or(0)
    }
    fn s(&self, code: i32) -> Option<&str> {
        self.fields.iter().find(|(c, _)| *c == code).map(|(_, v)| v.as_str())
    }
}

fn records(text: &str) -> Vec<Rec> {
    let mut lines = text.lines();
    let mut recs: Vec<Rec> = Vec::new();
    let mut cur: Option<Rec> = None;
    while let (Some(code), Some(val)) = (lines.next(), lines.next()) {
        let Ok(code) = code.trim().parse::<i32>() else { continue };
        let val = val.trim().to_string();
        if code == 0 {
            if let Some(r) = cur.take() {
                recs.push(r);
            }
            cur = Some(Rec { typ: val, fields: Vec::new() });
        } else if let Some(r) = cur.as_mut() {
            r.fields.push((code, val));
        }
    }
    if let Some(r) = cur {
        recs.push(r);
    }
    recs
}

/// AutoCAD Color Index → 0xRRGGBB for the common indices; index 7 (white) maps to black for plotting.
fn aci_to_rgb(i: i32) -> u32 {
    match i {
        1 => 0xFF0000,
        2 => 0xFFFF00,
        3 => 0x00FF00,
        4 => 0x00FFFF,
        5 => 0x0000FF,
        6 => 0xFF00FF,
        8 => 0x808080,
        9 => 0xC0C0C0,
        _ => 0x000000, // 7 (white) and unknown → black
    }
}

// ---- curve flattening --------------------------------------------------------------------------

fn arc_steps(sweep: f64) -> usize {
    ((sweep.abs() / (PI / 32.0)).ceil() as usize).clamp(2, 512)
}

/// Append the arc from `p0` to `p1` with DXF `bulge` (= tan(included_angle / 4)); straight if ~0.
fn push_bulge(out: &mut Ring, p0: (f64, f64), p1: (f64, f64), bulge: f64) {
    let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
    let chord = (dx * dx + dy * dy).sqrt();
    if bulge.abs() < 1e-9 || chord < 1e-9 {
        out.push(p1);
        return;
    }
    let theta = 4.0 * bulge.atan(); // signed included angle
    let r = chord / 2.0 / (theta / 2.0).sin(); // signed radius
    let apothem = r * (theta / 2.0).cos();
    let mid = ((p0.0 + p1.0) / 2.0, (p0.1 + p1.1) / 2.0);
    let (nx, ny) = (-dy / chord, dx / chord); // left normal of the chord
    let center = (mid.0 + nx * apothem, mid.1 + ny * apothem);
    let a0 = (p0.1 - center.1).atan2(p0.0 - center.0);
    let steps = arc_steps(theta);
    for i in 1..=steps {
        let a = a0 + theta * i as f64 / steps as f64;
        out.push((center.0 + r.abs() * a.cos(), center.1 + r.abs() * a.sin()));
    }
}

fn flatten_circle(cx: f64, cy: f64, r: f64) -> Ring {
    (0..72).map(|i| {
        let a = 2.0 * PI * i as f64 / 72.0;
        (cx + r * a.cos(), cy + r * a.sin())
    }).collect()
}

fn flatten_arc(cx: f64, cy: f64, r: f64, start_deg: f64, end_deg: f64) -> Ring {
    let a0 = start_deg.to_radians();
    let mut sweep = (end_deg - start_deg).to_radians();
    if sweep <= 0.0 {
        sweep += 2.0 * PI; // DXF arcs run CCW from start to end
    }
    let steps = arc_steps(sweep);
    (0..=steps).map(|i| {
        let a = a0 + sweep * i as f64 / steps as f64;
        (cx + r * a.cos(), cy + r * a.sin())
    }).collect()
}

/// `major` is the major-axis endpoint relative to centre; minor = major rotated 90° × ratio.
fn flatten_ellipse(c: (f64, f64), major: (f64, f64), ratio: f64, t0: f64, t1: f64) -> (Ring, bool) {
    let minor = (-major.1 * ratio, major.0 * ratio);
    let sweep = t1 - t0;
    let closed = sweep.abs() >= 2.0 * PI - 1e-3;
    let steps = arc_steps(sweep);
    let ring = (0..=steps).map(|i| {
        let t = t0 + sweep * i as f64 / steps as f64;
        (c.0 + major.0 * t.cos() + minor.0 * t.sin(), c.1 + major.1 * t.cos() + minor.1 * t.sin())
    }).collect();
    (ring, closed)
}

/// Sample a (non-rational) B-spline by de Boor; falls back to fit/control points if the knots are
/// unusable (degree 0, or `knots.len() != n + degree + 1`).
fn flatten_spline(degree: usize, knots: &[f64], ctrl: &[(f64, f64)], fit: &[(f64, f64)]) -> Ring {
    let (n, p) = (ctrl.len(), degree);
    if p == 0 || n < p + 1 || knots.len() != n + p + 1 {
        return if fit.len() >= 2 { fit.to_vec() } else { ctrl.to_vec() };
    }
    let (lo, hi) = (knots[p], knots[n]);
    let steps = (n * 16).clamp(16, 2048);
    (0..=steps).map(|i| {
        let t = (lo + (hi - lo) * i as f64 / steps as f64).clamp(lo, hi - 1e-9);
        deboor(p, knots, ctrl, t)
    }).collect()
}

fn deboor(p: usize, knots: &[f64], ctrl: &[(f64, f64)], t: f64) -> (f64, f64) {
    let n = ctrl.len();
    let mut k = p;
    while k < n - 1 && t >= knots[k + 1] {
        k += 1;
    }
    let mut d: Vec<(f64, f64)> = (0..=p).map(|j| ctrl[k - p + j]).collect();
    for r in 1..=p {
        for j in (r..=p).rev() {
            let i = k - p + j;
            let denom = knots[i + p - r + 1] - knots[i];
            let a = if denom.abs() < 1e-12 { 0.0 } else { (t - knots[i]) / denom };
            d[j] = (d[j - 1].0 + a * (d[j].0 - d[j - 1].0), d[j - 1].1 + a * (d[j].1 - d[j - 1].1));
        }
    }
    d[p]
}

// ---- entity → contour --------------------------------------------------------------------------

fn lwpoly_ring(r: &Rec) -> (Ring, bool) {
    let mut verts: Vec<(f64, f64, f64)> = Vec::new(); // x, y, bulge
    let mut closed = false;
    for (c, v) in &r.fields {
        match c {
            70 => closed = v.parse::<i32>().unwrap_or(0) & 1 != 0,
            10 => verts.push((v.parse().unwrap_or(0.0), 0.0, 0.0)),
            20 => {
                if let Some(last) = verts.last_mut() {
                    last.1 = v.parse().unwrap_or(0.0)
                }
            }
            42 => {
                if let Some(last) = verts.last_mut() {
                    last.2 = v.parse().unwrap_or(0.0)
                }
            }
            _ => {}
        }
    }
    if verts.is_empty() {
        return (Vec::new(), false);
    }
    let mut out: Ring = vec![(verts[0].0, verts[0].1)];
    for i in 0..verts.len() - 1 {
        push_bulge(&mut out, (verts[i].0, verts[i].1), (verts[i + 1].0, verts[i + 1].1), verts[i].2);
    }
    if closed {
        let last = verts.len() - 1;
        push_bulge(&mut out, (verts[last].0, verts[last].1), (verts[0].0, verts[0].1), verts[last].2);
    }
    (out, closed)
}

fn spline_ring(r: &Rec) -> Ring {
    let mut degree = 3;
    let mut knots: Vec<f64> = Vec::new();
    let mut ctrl: Vec<(f64, f64)> = Vec::new();
    let mut fit: Vec<(f64, f64)> = Vec::new();
    for (c, v) in &r.fields {
        match c {
            71 => degree = v.parse().unwrap_or(3),
            40 => knots.push(v.parse().unwrap_or(0.0)),
            10 => ctrl.push((v.parse().unwrap_or(0.0), 0.0)),
            20 => {
                if let Some(l) = ctrl.last_mut() {
                    l.1 = v.parse().unwrap_or(0.0)
                }
            }
            11 => fit.push((v.parse().unwrap_or(0.0), 0.0)),
            21 => {
                if let Some(l) = fit.last_mut() {
                    l.1 = v.parse().unwrap_or(0.0)
                }
            }
            _ => {}
        }
    }
    flatten_spline(degree.max(0) as usize, &knots, &ctrl, &fit)
}

fn entity_ring(r: &Rec) -> Option<(Ring, bool)> {
    match r.typ.as_str() {
        "LINE" => Some((vec![(r.f(10), r.f(20)), (r.f(11), r.f(21))], false)),
        "CIRCLE" => Some((flatten_circle(r.f(10), r.f(20), r.f(40)), true)),
        "ARC" => Some((flatten_arc(r.f(10), r.f(20), r.f(40), r.f(50), r.f(51)), false)),
        "ELLIPSE" => Some(flatten_ellipse((r.f(10), r.f(20)), (r.f(11), r.f(21)), r.f(40), r.f(41), r.f(42))),
        "LWPOLYLINE" => Some(lwpoly_ring(r)),
        "SPLINE" => Some((spline_ring(r), false)),
        _ => None,
    }
}

pub fn import(bytes: &[u8], params_json: &str) -> DxfImport {
    let p: Params = serde_json::from_str(params_json).unwrap_or_default();
    let text = String::from_utf8_lossy(bytes);
    let recs = records(&text);

    let mut section = String::new();
    let mut insunits: u32 = 0;
    let mut layer_rgb: HashMap<String, u32> = HashMap::new();
    let mut rings: Vec<(Ring, bool, u32)> = Vec::new();

    let mut i = 0;
    while i < recs.len() {
        let r = &recs[i];
        match r.typ.as_str() {
            "SECTION" => {
                section = r.s(2).unwrap_or("").to_string();
                if section == "HEADER" {
                    // HEADER variables are fields of this record: a (9, "$INSUNITS") then a (70, n).
                    for j in 0..r.fields.len() {
                        if r.fields[j].0 == 9 && r.fields[j].1 == "$INSUNITS" {
                            if let Some((70, v)) = r.fields.get(j + 1).map(|(c, v)| (*c, v)) {
                                insunits = v.parse().unwrap_or(0);
                            }
                        }
                    }
                }
            }
            "ENDSEC" => section.clear(),
            "LAYER" if section == "TABLES" => {
                if let Some(name) = r.s(2) {
                    layer_rgb.insert(name.to_string(), aci_to_rgb(r.i(62)));
                }
            }
            _ if section == "ENTITIES" => {
                let rgb = match r.i(62) {
                    aci if aci >= 1 => aci_to_rgb(aci),
                    _ => *layer_rgb.get(r.s(8).unwrap_or("")).unwrap_or(&0x000000),
                };
                if r.typ == "POLYLINE" {
                    // Old-style polyline: vertices are the following VERTEX records up to SEQEND.
                    let closed = r.i(70) & 1 != 0;
                    let mut pts: Ring = Vec::new();
                    i += 1;
                    while i < recs.len() && recs[i].typ == "VERTEX" {
                        pts.push((recs[i].f(10), recs[i].f(20)));
                        i += 1;
                    }
                    if i < recs.len() && recs[i].typ == "SEQEND" {
                        i += 1;
                    }
                    if pts.len() >= 2 {
                        rings.push((pts, closed, rgb));
                    }
                    continue;
                }
                if let Some((pts, closed)) = entity_ring(r) {
                    if pts.len() >= 2 {
                        rings.push((pts, closed, rgb));
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }

    // Import at actual size: mm = DXF coord × unit_scale, Y-flipped (DXF is Y-up). TS centres on the
    // bed. Then (optionally) chain shared-endpoint segments into polylines.
    let s = p.unit_scale as f64;
    let mut mm: Vec<(Ring, bool, u32)> = rings
        .into_iter()
        .map(|(pts, closed, rgb)| (pts.into_iter().map(|(x, y)| (x * s, -y * s)).collect(), closed, rgb))
        .collect();
    if p.merge {
        mm = merge_chains(mm, 0.05);
    }

    let mut out = Out { insunits, ..Out::default() };
    out.ring_starts.push(0);
    out.shape_starts.push(0);
    for (pts, closed, rgb) in mm {
        if pts.len() < 2 {
            continue;
        }
        for &(x, y) in &pts {
            out.xy.push(x as f32);
            out.xy.push(y as f32);
        }
        out.ring_starts.push((out.xy.len() / 2) as u32);
        out.ring_closed.push(closed as u8);
        out.shape_starts.push(out.ring_starts.len() as u32 - 1);
        out.colors.push(rgb);
    }
    DxfImport { inner: out }
}

/// Snap an endpoint to a `tol`-grid cell, for matching shared endpoints despite float noise.
fn qkey(p: (f64, f64), tol: f64) -> (i64, i64) {
    ((p.0 / tol).round() as i64, (p.1 / tol).round() as i64)
}

/// Chain open segments that share endpoints into longer polylines (per colour); closed contours pass
/// through untouched. Greedy: grow each chain from both ends by any unused segment touching its tip.
fn merge_chains(rings: Vec<(Ring, bool, u32)>, tol: f64) -> Vec<(Ring, bool, u32)> {
    let mut out: Vec<(Ring, bool, u32)> = Vec::new();
    let mut by_color: HashMap<u32, Vec<Ring>> = HashMap::new();
    for (pts, closed, rgb) in rings {
        if pts.len() < 2 {
            continue;
        }
        if closed {
            out.push((pts, closed, rgb));
        } else {
            by_color.entry(rgb).or_default().push(pts);
        }
    }
    let mut colors: Vec<u32> = by_color.keys().copied().collect();
    colors.sort_unstable();
    for rgb in colors {
        let segs = by_color.remove(&rgb).unwrap();
        for chain in chain_polylines(&segs, tol) {
            let closed = chain.len() > 2 && qkey(chain[0], tol) == qkey(*chain.last().unwrap(), tol);
            out.push((chain, closed, rgb));
        }
    }
    out
}

fn chain_polylines(segs: &[Ring], tol: f64) -> Vec<Ring> {
    // endpoint cell -> list of (segment index, which end: 0 = start, 1 = last)
    let mut ends: HashMap<(i64, i64), Vec<(usize, usize)>> = HashMap::new();
    for (i, s) in segs.iter().enumerate() {
        ends.entry(qkey(s[0], tol)).or_default().push((i, 0));
        ends.entry(qkey(*s.last().unwrap(), tol)).or_default().push((i, 1));
    }
    let pick = |ends: &HashMap<(i64, i64), Vec<(usize, usize)>>, used: &[bool], k: (i64, i64)| {
        ends.get(&k).and_then(|c| c.iter().copied().find(|&(si, _)| !used[si]))
    };
    let mut used = vec![false; segs.len()];
    let mut out: Vec<Ring> = Vec::new();
    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut chain = segs[start].clone();
        // Grow forward from the chain's tail.
        while let Some((si, end)) = pick(&ends, &used, qkey(*chain.last().unwrap(), tol)) {
            used[si] = true;
            let seg = &segs[si];
            let oriented: Ring = if end == 0 { seg.clone() } else { seg.iter().rev().copied().collect() };
            chain.extend_from_slice(&oriented[1..]); // skip the duplicated shared point
        }
        // Grow backward from the chain's head.
        while let Some((si, end)) = pick(&ends, &used, qkey(chain[0], tol)) {
            used[si] = true;
            let seg = &segs[si];
            let oriented: Ring = if end == 1 { seg.clone() } else { seg.iter().rev().copied().collect() };
            let mut next = oriented[..oriented.len() - 1].to_vec();
            next.extend_from_slice(&chain);
            chain = next;
        }
        out.push(chain);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_a_line_and_circle() {
        let dxf = "0\nSECTION\n2\nENTITIES\n0\nLINE\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n0\nCIRCLE\n8\n0\n10\n5\n20\n5\n40\n2\n0\nENDSEC\n0\nEOF\n";
        let res = import(dxf.as_bytes(), r#"{"merge":false}"#);
        assert_eq!(res.inner.colors.len(), 2, "two entities → two shapes");
        assert_eq!(res.inner.ring_closed, vec![0, 1], "line open, circle closed");
        assert!(res.inner.xy.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn merges_chained_line_segments() {
        // Four LINEs forming a square loop → one closed ring (instead of four elements).
        let seg = |x0, y0, x1, y1| format!("0\nLINE\n8\n0\n10\n{x0}\n20\n{y0}\n11\n{x1}\n21\n{y1}\n");
        let dxf = format!(
            "0\nSECTION\n2\nENTITIES\n{}{}{}{}0\nENDSEC\n0\nEOF\n",
            seg(0, 0, 10, 0),
            seg(10, 0, 10, 10),
            seg(10, 10, 0, 10),
            seg(0, 10, 0, 0),
        );
        let res = import(dxf.as_bytes(), r#"{"merge":true}"#);
        assert_eq!(res.inner.colors.len(), 1, "four segments merge into one polyline");
        assert_eq!(res.inner.ring_closed, vec![1], "the closed loop is detected");

        let unmerged = import(dxf.as_bytes(), r#"{"merge":false}"#);
        assert_eq!(unmerged.inner.colors.len(), 4, "merge off keeps them separate");
    }

    #[test]
    fn closed_lwpolyline() {
        // A 3-vertex closed LWPOLYLINE → a closed ring.
        let dxf = "0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n90\n3\n70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n5\n20\n8\n0\nENDSEC\n0\nEOF\n";
        let res = import(dxf.as_bytes(), r#"{"merge":false}"#);
        assert_eq!(res.inner.colors.len(), 1);
        assert_eq!(res.inner.ring_closed, vec![1], "closed flag honoured");
    }
}
