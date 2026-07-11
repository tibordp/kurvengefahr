//! Offset (inset / outset): grow (+) or shrink (−) the element's stroke **region** by a signed
//! distance, via i_overlay's outline offsetting. Open strokes are silently closed end-to-start
//! first (the Inkscape convention), then everything is normalized as one even-odd region per pen
//! (multi-colour elements keep their colours), matching how the app fills paths — nested rings
//! are holes, so an outset grows outer rings and shrinks holes (text gets bolder, a donut's wall
//! gets thicker). An inset past a shape's inradius collapses it to nothing; so does any offset of
//! a zero-area contour. Strokes with fewer than 3 points (dots, bare segments) can't enclose
//! anything and pass through untouched.

use super::{is_closed, EffectSpec};
use crate::geom::{Point, Stroke};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use i_overlay::mesh::outline::offset::OutlineOffset;
use i_overlay::mesh::style::{LineJoin, OutlineStyle};

pub fn apply(strokes: &[Stroke], spec: &EffectSpec) -> Vec<Stroke> {
    let d = spec.offset_mm;
    if d.abs() < 1e-6 {
        return strokes.to_vec();
    }

    // Bucket contours by pen (first-appearance order). Closed strokes shed their explicit closing
    // vertex (i_overlay contours close implicitly); open strokes are implicitly closed
    // end-to-start by the same convention. Sub-3-point strokes can't enclose area — pass through.
    let mut out: Vec<Stroke> = Vec::new();
    let mut pens: Vec<u16> = Vec::new();
    let mut buckets: Vec<(Vec<Vec<[f32; 2]>>, &Stroke)> = Vec::new();
    for s in strokes {
        if s.points.len() < 3 {
            out.push(s.clone());
            continue;
        }
        let pts = if is_closed(&s.points) {
            &s.points[..s.points.len() - 1]
        } else {
            &s.points[..]
        };
        let ring: Vec<[f32; 2]> = pts.iter().map(|p| [p.x, p.y]).collect();
        match pens.iter().position(|&p| p == s.pen) {
            Some(i) => buckets[i].0.push(ring),
            None => {
                pens.push(s.pen);
                buckets.push((vec![ring], s));
            }
        }
    }

    let style = OutlineStyle::new(d).line_join(LineJoin::Round(0.25));
    let empty: Vec<Vec<[f32; 2]>> = Vec::new();
    for (contours, src) in &buckets {
        // Normalize to canonical winding (outer CCW, holes CW) under even-odd — the outline
        // builder is orientation-sensitive, and tessellated rings arrive with arbitrary winding.
        let shapes = contours.overlay(&empty, OverlayRule::Subject, FillRule::EvenOdd);
        let pressure = src.points.first().map(|p| p.pressure).unwrap_or(1.0);
        for shape in &shapes.outline(&style) {
            for contour in shape {
                if contour.len() < 3 {
                    continue;
                }
                let mut points: Vec<Point> = contour
                    .iter()
                    .map(|p| Point {
                        x: p[0],
                        y: p[1],
                        pressure,
                    })
                    .collect();
                points.push(points[0]); // effects emit drawn polylines — close explicitly
                out.push(Stroke {
                    points,
                    pen: src.pen,
                    reversible: src.reversible,
                    group: src.group,
                });
            }
        }
    }
    out
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

    fn spec(d: f32) -> EffectSpec {
        EffectSpec {
            kind: "offset".into(),
            enabled: true,
            offset_mm: d,
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

    /// A 10×10 square at the origin, wound as given.
    fn square(pen: u16) -> Stroke {
        ring(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)], pen)
    }

    #[test]
    fn outset_grows_and_inset_shrinks() {
        let out = apply(&[square(0)], &spec(2.0));
        assert_eq!(out.len(), 1);
        let (x0, y0, x1, y1) = bbox(&out[0]);
        assert!((x0 - -2.0).abs() < 0.05 && (y0 - -2.0).abs() < 0.05);
        assert!((x1 - 12.0).abs() < 0.05 && (y1 - 12.0).abs() < 0.05);

        let inn = apply(&[square(0)], &spec(-2.0));
        assert_eq!(inn.len(), 1);
        let (x0, y0, x1, y1) = bbox(&inn[0]);
        assert!((x0 - 2.0).abs() < 0.05 && (y0 - 2.0).abs() < 0.05);
        assert!((x1 - 8.0).abs() < 0.05 && (y1 - 8.0).abs() < 0.05);
    }

    #[test]
    fn winding_direction_does_not_matter() {
        // The same square wound clockwise must offset identically (normalization pass).
        let cw = ring(&[(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0)], 0);
        let out = apply(&[cw], &spec(2.0));
        assert_eq!(out.len(), 1);
        let (x0, _, x1, _) = bbox(&out[0]);
        assert!((x0 - -2.0).abs() < 0.05 && (x1 - 12.0).abs() < 0.05);
    }

    #[test]
    fn inset_past_the_inradius_collapses_the_shape() {
        let out = apply(&[square(0)], &spec(-6.0));
        assert!(out.is_empty(), "a 10mm square inset by 6mm vanishes");
    }

    #[test]
    fn outset_shrinks_holes_region_semantics() {
        // A donut: 20mm square with a 10mm hole (both CCW — parity decides, not winding).
        let outer = ring(&[(0.0, 0.0), (20.0, 0.0), (20.0, 20.0), (0.0, 20.0)], 0);
        let hole = ring(&[(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)], 0);
        let out = apply(&[outer, hole], &spec(1.0));
        assert_eq!(out.len(), 2, "outer ring + hole survive");
        let (a, b) = (bbox(&out[0]), bbox(&out[1]));
        let (big, small) = if a.2 - a.0 > b.2 - b.0 {
            (a, b)
        } else {
            (b, a)
        };
        assert!((big.2 - big.0 - 22.0).abs() < 0.1, "outer grew to 22mm");
        assert!((small.2 - small.0 - 8.0).abs() < 0.1, "hole shrank to 8mm");
    }

    /// An open right-angle stroke (no closing vertex): implicit closure makes it a triangle.
    fn open_angle(pen: u16) -> Stroke {
        let points = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)]
            .iter()
            .map(|&(x, y)| Point {
                x,
                y,
                pressure: 1.0,
            })
            .collect();
        Stroke {
            points,
            pen,
            reversible: false,
            group: 7,
        }
    }

    #[test]
    fn open_strokes_are_silently_closed() {
        // Outset of the implicit triangle grows past the original bbox on every side.
        let out = apply(&[open_angle(2)], &spec(1.0));
        assert_eq!(out.len(), 1);
        assert!(
            is_closed(&out[0].points),
            "offsetting closes the open stroke"
        );
        assert_eq!(out[0].pen, 2);
        assert_eq!(out[0].group, 7);
        let (x0, y0, x1, y1) = bbox(&out[0]);
        assert!(x0 < -0.5 && y0 < -0.5 && x1 > 10.5 && y1 > 10.5);

        // Inset shrinks the same implicit region (10mm right triangle: inradius ≈ 2.9mm).
        let inn = apply(&[open_angle(2)], &spec(-2.0));
        assert_eq!(inn.len(), 1);
        let (x0, _, x1, _) = bbox(&inn[0]);
        assert!(x1 - x0 < 8.0, "inset triangle is smaller (got {})", x1 - x0);
    }

    #[test]
    fn sub_three_point_strokes_pass_through() {
        let segment = Stroke {
            points: vec![
                Point {
                    x: 0.0,
                    y: 0.0,
                    pressure: 0.5,
                },
                Point {
                    x: 30.0,
                    y: 0.0,
                    pressure: 0.5,
                },
            ],
            pen: 2,
            reversible: false,
            group: 7,
        };
        let out = apply(&[segment, square(0)], &spec(3.0));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].points.len(), 2);
        assert_eq!(out[0].pen, 2);
    }

    #[test]
    fn pens_offset_as_separate_regions() {
        // Two overlapping squares with different pens must NOT merge or punch even-odd holes into
        // each other — each pen is its own region.
        let a = square(0);
        let b = ring(&[(5.0, 5.0), (15.0, 5.0), (15.0, 15.0), (5.0, 15.0)], 1);
        let out = apply(&[a, b], &spec(1.0));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].pen, 0);
        assert_eq!(out[1].pen, 1);
    }

    #[test]
    fn output_rings_close_explicitly() {
        for s in apply(&[square(3)], &spec(1.5)) {
            assert!(
                is_closed(&s.points),
                "offset rings must stay drawable loops"
            );
            assert_eq!(s.pen, 3);
        }
    }

    #[test]
    fn zero_offset_is_a_noop() {
        let input = vec![square(0)];
        let out = apply(&input, &spec(0.0));
        assert_eq!(out[0].points.len(), input[0].points.len());
    }
}
