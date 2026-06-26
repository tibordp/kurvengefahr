//! Boolean operations on closed polygons (union / intersection / difference / xor), via i_overlay.
//! Inputs and outputs are multi-contour: a flat point buffer + CSR ring offsets (point units). The
//! `boolean` WASM export wraps `combine` and returns one `Stroke` per result ring, so a path element
//! can adopt the result as its contours (outer rings + holes, filled even-odd). Inputs are
//! interpreted even-odd to match how the app's paths already render holes; orientation is irrelevant.

use crate::geom::{Point, Stroke};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

fn rule(op: u32) -> OverlayRule {
    match op {
        0 => OverlayRule::Union,
        1 => OverlayRule::Intersect,
        2 => OverlayRule::Difference,
        _ => OverlayRule::Xor,
    }
}

/// Split a flat `xy` into contours via `starts` (point units, `nrings+1` entries), dropping each
/// ring's trailing vertex when it duplicates the first (our tessellated outlines close explicitly).
fn to_contours(xy: &[f32], starts: &[u32]) -> Vec<Vec<[f32; 2]>> {
    let n = starts.len().saturating_sub(1);
    (0..n)
        .map(|r| {
            let s = starts[r] as usize;
            let e = starts[r + 1] as usize;
            let mut ring: Vec<[f32; 2]> = (s..e).map(|i| [xy[2 * i], xy[2 * i + 1]]).collect();
            if ring.len() >= 2 {
                let f = ring[0];
                let l = *ring.last().unwrap();
                if (f[0] - l[0]).abs() < 1e-6 && (f[1] - l[1]).abs() < 1e-6 {
                    ring.pop();
                }
            }
            ring
        })
        .collect()
}

/// Boolean `op` (0 union, 1 intersect, 2 difference, 3 xor) between two multi-contour inputs.
/// Returns one stroke per result ring (each a closed contour; outer rings and holes both appear).
pub fn combine(
    op: u32,
    subj_xy: &[f32],
    subj_starts: &[u32],
    clip_xy: &[f32],
    clip_starts: &[u32],
) -> Vec<Stroke> {
    let subj = to_contours(subj_xy, subj_starts);
    let clip = to_contours(clip_xy, clip_starts);
    let shapes = subj.overlay(&clip, rule(op), FillRule::EvenOdd);
    let mut out = Vec::new();
    for shape in &shapes {
        for contour in shape {
            if contour.len() < 3 {
                continue
            }
            let points = contour
                .iter()
                .map(|p| Point { x: p[0], y: p[1], pressure: 1.0 })
                .collect();
            out.push(Stroke { points, pen: 0, reversible: true, group: 0 });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(pts: &[(f32, f32)]) -> (Vec<f32>, Vec<u32>) {
        let xy: Vec<f32> = pts.iter().flat_map(|&(x, y)| [x, y]).collect();
        (xy, vec![0, pts.len() as u32])
    }

    #[test]
    fn union_of_two_overlapping_squares_is_one_ring() {
        let (sx, ss) = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)]);
        let (cx, cs) = ring(&[(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)]);
        let out = combine(0, &sx, &ss, &cx, &cs);
        assert_eq!(out.len(), 1, "union of overlapping squares is a single contour");
    }

    #[test]
    fn difference_with_interior_clip_makes_a_hole() {
        // A small square fully inside a big one, subtracted → outer ring + hole = two contours.
        let (sx, ss) = ring(&[(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)]);
        let (cx, cs) = ring(&[(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)]);
        let out = combine(2, &sx, &ss, &cx, &cs);
        assert_eq!(out.len(), 2, "difference with an interior clip yields outer + hole");
    }

    #[test]
    fn strips_duplicate_closing_vertex() {
        // Rings that close explicitly (last == first), as our tessellated outlines do.
        let (sx, ss) = ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]);
        let (cx, cs) = ring(&[(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0), (5.0, 5.0)]);
        let out = combine(0, &sx, &ss, &cx, &cs);
        assert_eq!(out.len(), 1, "closed-with-duplicate rings still union cleanly");
    }

    #[test]
    fn intersection_of_disjoint_is_empty() {
        let (sx, ss) = ring(&[(0.0, 0.0), (5.0, 0.0), (5.0, 5.0), (0.0, 5.0)]);
        let (cx, cs) = ring(&[(10.0, 10.0), (15.0, 10.0), (15.0, 15.0), (10.0, 15.0)]);
        let out = combine(1, &sx, &ss, &cx, &cs);
        assert!(out.is_empty(), "disjoint shapes do not intersect");
    }
}
