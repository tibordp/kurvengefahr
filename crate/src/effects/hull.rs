//! Hull: keep only the outermost boundary of the element's stroke region, discarding everything
//! inside it. Open strokes are silently closed end-to-start first (like offset), and each pen is
//! its own region (multi-colour elements keep their colours). Default is the *concave* silhouette:
//! the union of all closed contours under non-zero fill — overlapping shapes merge, and interior
//! detail and holes vanish (a hatched star becomes just the star outline; a donut loses its
//! hole); disjoint islands each keep their own outline. Non-zero (after normalizing every ring to
//! one winding) rather than even-odd, because even-odd would XOR overlaps into holes — the exact
//! opposite of a hull. `convex` instead takes the convex hull of all the pen's points — one loop
//! per pen, and even dots and bare segments participate. In concave mode sub-3-point strokes
//! can't enclose area and pass through untouched.

use super::{is_closed, EffectSpec};
use crate::geom::{Point, Stroke};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

pub fn apply(strokes: &[Stroke], spec: &EffectSpec) -> Vec<Stroke> {
    if spec.convex {
        convex(strokes)
    } else {
        concave(strokes)
    }
}

/// Ring vertices without the explicit closing vertex (i_overlay closes implicitly); an open
/// stroke's points already are the implicitly-closed ring.
fn ring_of(s: &Stroke) -> Vec<[f32; 2]> {
    let pts = if is_closed(&s.points) {
        &s.points[..s.points.len() - 1]
    } else {
        &s.points[..]
    };
    pts.iter().map(|p| [p.x, p.y]).collect()
}

/// Emit one drawn (explicitly closed) stroke per contour, with the bucket's metadata.
fn contour_stroke(contour: &[[f32; 2]], src: &Stroke) -> Stroke {
    let pressure = src.points.first().map(|p| p.pressure).unwrap_or(1.0);
    let mut points: Vec<Point> = contour
        .iter()
        .map(|p| Point {
            x: p[0],
            y: p[1],
            pressure,
        })
        .collect();
    points.push(points[0]);
    Stroke {
        points,
        pen: src.pen,
        reversible: src.reversible,
        group: src.group,
    }
}

fn concave(strokes: &[Stroke]) -> Vec<Stroke> {
    // Bucket contours by pen (first-appearance order), offset-style.
    let mut out: Vec<Stroke> = Vec::new();
    let mut pens: Vec<u16> = Vec::new();
    let mut buckets: Vec<(Vec<Vec<[f32; 2]>>, &Stroke)> = Vec::new();
    for s in strokes {
        if s.points.len() < 3 {
            out.push(s.clone());
            continue;
        }
        // Non-zero fill counts winding, and tessellated rings arrive wound arbitrarily — flip
        // every ring to positive signed area so overlaps accumulate instead of cancelling.
        let mut ring = ring_of(s);
        if signed_area(&ring) < 0.0 {
            ring.reverse();
        }
        match pens.iter().position(|&p| p == s.pen) {
            Some(i) => buckets[i].0.push(ring),
            None => {
                pens.push(s.pen);
                buckets.push((vec![ring], s));
            }
        }
    }

    let empty: Vec<Vec<[f32; 2]>> = Vec::new();
    for (contours, src) in &buckets {
        let shapes = contours.overlay(&empty, OverlayRule::Subject, FillRule::NonZero);
        for shape in &shapes {
            // Shape layout is [outer, holes…] — the hull is the outer boundary alone.
            let Some(outer) = shape.first() else { continue };
            if outer.len() < 3 {
                continue;
            }
            out.push(contour_stroke(outer, src));
        }
    }
    out
}

fn convex(strokes: &[Stroke]) -> Vec<Stroke> {
    let mut pens: Vec<u16> = Vec::new();
    let mut buckets: Vec<(Vec<[f32; 2]>, &Stroke)> = Vec::new();
    for s in strokes {
        let pts = s.points.iter().map(|p| [p.x, p.y]);
        match pens.iter().position(|&p| p == s.pen) {
            Some(i) => buckets[i].0.extend(pts),
            None => {
                pens.push(s.pen);
                buckets.push((pts.collect(), s));
            }
        }
    }

    let mut out = Vec::new();
    for (points, src) in &buckets {
        let hull = convex_hull(points);
        if hull.len() < 3 {
            continue; // all points coincident/collinear — nothing encloses area
        }
        out.push(contour_stroke(&hull, src));
    }
    out
}

/// Twice the shoelace signed area (sign is all we use).
fn signed_area(ring: &[[f32; 2]]) -> f32 {
    let mut a = 0.0f32;
    for i in 0..ring.len() {
        let p = ring[i];
        let q = ring[(i + 1) % ring.len()];
        a += p[0] * q[1] - q[0] * p[1];
    }
    a
}

/// Andrew's monotone chain. Returns the hull vertices in order (no closing vertex); collinear
/// interior points are dropped. Fewer than 3 distinct non-collinear points → a degenerate result
/// shorter than 3.
fn convex_hull(points: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let mut pts: Vec<[f32; 2]> = points.to_vec();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: [f32; 2], a: [f32; 2], b: [f32; 2]| -> f32 {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let mut hull: Vec<[f32; 2]> = Vec::with_capacity(pts.len() + 1);
    for half in 0..2 {
        let start = hull.len();
        let iter: Box<dyn Iterator<Item = &[f32; 2]>> = if half == 0 {
            Box::new(pts.iter())
        } else {
            Box::new(pts.iter().rev())
        };
        for &p in iter {
            while hull.len() >= start + 2
                && cross(hull[hull.len() - 2], hull[hull.len() - 1], p) <= 0.0
            {
                hull.pop();
            }
            hull.push(p);
        }
        hull.pop(); // each chain's last point is the other chain's first
    }
    hull
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(pts: &[(f32, f32)], pen: u16) -> Stroke {
        let mut points: Vec<Point> = pts
            .iter()
            .map(|&(x, y)| Point {
                x,
                y,
                pressure: 1.0,
            })
            .collect();
        points.push(points[0]);
        Stroke {
            points,
            pen,
            reversible: true,
            group: 0,
        }
    }

    fn open(pts: &[(f32, f32)], pen: u16) -> Stroke {
        Stroke {
            points: pts
                .iter()
                .map(|&(x, y)| Point {
                    x,
                    y,
                    pressure: 1.0,
                })
                .collect(),
            pen,
            reversible: false,
            group: 7,
        }
    }

    fn spec(convex: bool) -> EffectSpec {
        EffectSpec {
            kind: "hull".into(),
            enabled: true,
            convex,
            ..Default::default()
        }
    }

    fn bbox(s: &Stroke) -> (f32, f32, f32, f32) {
        s.points.iter().fold(
            (
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            ),
            |(x0, y0, x1, y1), p| (x0.min(p.x), y0.min(p.y), x1.max(p.x), y1.max(p.y)),
        )
    }

    fn square(x: f32, y: f32, size: f32, pen: u16) -> Stroke {
        ring(
            &[(x, y), (x + size, y), (x + size, y + size), (x, y + size)],
            pen,
        )
    }

    #[test]
    fn overlapping_shapes_merge_into_one_silhouette() {
        // Even-odd would cut the overlap out as a hole; the hull must merge instead.
        let out = apply(
            &[square(0.0, 0.0, 10.0, 0), square(5.0, 5.0, 10.0, 0)],
            &spec(false),
        );
        assert_eq!(out.len(), 1, "one merged outline");
        let (x0, y0, x1, y1) = bbox(&out[0]);
        assert!((x0, y0) == (0.0, 0.0) && (x1, y1) == (15.0, 15.0));
        assert!(is_closed(&out[0].points));
    }

    #[test]
    fn interior_detail_and_holes_are_discarded() {
        // A donut plus a wiggle inside: only the outer ring survives.
        let outer = square(0.0, 0.0, 20.0, 0);
        let hole = square(5.0, 5.0, 10.0, 0);
        let scribble = open(&[(7.0, 7.0), (12.0, 9.0), (8.0, 12.0)], 0);
        let out = apply(&[outer, hole, scribble], &spec(false));
        assert_eq!(out.len(), 1, "hole and scribble discarded");
        let (x0, y0, x1, y1) = bbox(&out[0]);
        assert!((x0, y0) == (0.0, 0.0) && (x1, y1) == (20.0, 20.0));
    }

    #[test]
    fn winding_direction_does_not_matter() {
        // The same overlap with one ring wound the other way must still merge (normalization).
        let cw = ring(&[(5.0, 5.0), (5.0, 15.0), (15.0, 15.0), (15.0, 5.0)], 0);
        let out = apply(&[square(0.0, 0.0, 10.0, 0), cw], &spec(false));
        assert_eq!(out.len(), 1);
        let (_, _, x1, y1) = bbox(&out[0]);
        assert!((x1, y1) == (15.0, 15.0));
    }

    #[test]
    fn disjoint_islands_each_keep_their_outline() {
        let out = apply(
            &[square(0.0, 0.0, 10.0, 0), square(30.0, 0.0, 10.0, 0)],
            &spec(false),
        );
        assert_eq!(out.len(), 2, "separate islands stay separate");
    }

    #[test]
    fn open_strokes_are_silently_closed() {
        // An open right angle closes into a triangle whose outline is the hull.
        let out = apply(
            &[open(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], 2)],
            &spec(false),
        );
        assert_eq!(out.len(), 1);
        assert!(is_closed(&out[0].points));
        assert_eq!(out[0].pen, 2);
        assert_eq!(out[0].group, 7);
    }

    #[test]
    fn concave_passes_sub_three_point_strokes_through() {
        let dot = open(&[(50.0, 50.0), (50.1, 50.0)], 0);
        let out = apply(&[dot, square(0.0, 0.0, 10.0, 0)], &spec(false));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].points.len(), 2, "segment untouched");
    }

    #[test]
    fn pens_hull_as_separate_regions() {
        let out = apply(
            &[square(0.0, 0.0, 10.0, 0), square(5.0, 5.0, 10.0, 1)],
            &spec(false),
        );
        assert_eq!(out.len(), 2, "different pens never merge");
        assert_eq!(out[0].pen, 0);
        assert_eq!(out[1].pen, 1);
    }

    #[test]
    fn convex_spans_disjoint_shapes() {
        // Two separate squares: concave gives two outlines, convex one enclosing loop.
        let strokes = [square(0.0, 0.0, 10.0, 3), square(30.0, 0.0, 10.0, 3)];
        let out = apply(&strokes, &spec(true));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pen, 3);
        assert!(is_closed(&out[0].points));
        let (x0, y0, x1, y1) = bbox(&out[0]);
        assert!((x0, y0) == (0.0, 0.0) && (x1, y1) == (40.0, 10.0));
        // A convex quad: 4 corners + the closing vertex.
        assert_eq!(out[0].points.len(), 5);
    }

    #[test]
    fn convex_rounds_off_concavities() {
        // An L-shape: the concave notch disappears, leaving the enclosing right triangle-ish quad.
        let l = ring(
            &[
                (0.0, 0.0),
                (20.0, 0.0),
                (20.0, 10.0),
                (10.0, 10.0),
                (10.0, 20.0),
                (0.0, 20.0),
            ],
            0,
        );
        let out = apply(&[l], &spec(true));
        assert_eq!(out.len(), 1);
        // The notch corner (20,20 side) is spanned: 5 hull vertices + closing.
        assert_eq!(out[0].points.len(), 6);
    }

    #[test]
    fn convex_includes_dots_and_segments() {
        // A bare segment sticking out extends the convex hull.
        let seg = open(&[(5.0, 5.0), (30.0, 5.0)], 0);
        let out = apply(&[square(0.0, 0.0, 10.0, 0), seg], &spec(true));
        assert_eq!(out.len(), 1, "segment absorbed, not passed through");
        let (_, _, x1, _) = bbox(&out[0]);
        assert!((x1 - 30.0).abs() < 1e-6, "hull reaches the segment tip");
    }

    #[test]
    fn convex_of_collinear_points_is_dropped() {
        let seg = open(&[(0.0, 0.0), (10.0, 0.0), (20.0, 0.0)], 0);
        let out = apply(&[seg], &spec(true));
        assert!(out.is_empty(), "no area to enclose");
    }

    #[test]
    fn hull_via_json_dispatch() {
        let strokes = [square(0.0, 0.0, 10.0, 0), square(5.0, 5.0, 10.0, 0)];
        let out = super::super::apply(
            &strokes,
            r#"[{"type":"hull","enabled":true,"convex":false}]"#,
        );
        assert_eq!(out.len(), 1);
        let convex = super::super::apply(
            &strokes,
            r#"[{"type":"hull","enabled":true,"convex":true}]"#,
        );
        assert_eq!(convex.len(), 1);
        assert!(
            convex[0].points.len() < out[0].points.len(),
            "convex hull has fewer vertices"
        );
    }
}
