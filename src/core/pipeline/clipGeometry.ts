// Clip-to-shape geometry. A `clip` element has no registered generator; its local geometry is its
// non-mask members (each placed by its own clip-local transform — recursing for nested clips, with
// the child's pen stamped on) clipped to the mask member's boundary rings. `place(…, clip.transform)`
// in buildPageGeometry then lifts it to the page, so the clip transforms as one nested object.
import type { DocElement, Geometry, Point } from '../types'
import { generateLocal, isMultiPen } from '../../elements/registry'
import { place } from './place'
import { clipToPolygon } from './clip'
import { rectGeometry, ellipseGeometry } from '../wasm/shapes'
import { pathOutlineStrokes, type RectParams, type EllipseParams, type PathParams } from '../../elements/shapes'

const CLOSE_EPS = 1e-3
const isClosed = (s: { points: Point[] }) =>
  s.points.length >= 3 &&
  Math.hypot(s.points[0].x - s.points[s.points.length - 1].x, s.points[0].y - s.points[s.points.length - 1].y) < CLOSE_EPS

/** The element's boundary contours (outline only, no fill), local mm — the clip mask region. Shapes
 *  use their outline; any other type falls back to its closed generated contours (e.g. text outline). */
function maskOutlineLocal(el: DocElement): Geometry {
  if (el.type === 'rect') {
    const p = el.params as RectParams
    return rectGeometry(p.w, p.h, p.cornerRadius)
  }
  if (el.type === 'ellipse') {
    const p = el.params as EllipseParams
    return ellipseGeometry(p.rx, p.ry)
  }
  if (el.type === 'path') {
    const p = el.params as PathParams
    return pathOutlineStrokes(p.contours.filter((c) => c.closed))
  }
  return generateLocal(el).filter(isClosed)
}

/** Local geometry of any element: a clip computes its clipped composition; everything else uses its
 *  registered generator. */
export function elementLocalGeometry(el: DocElement, membersOf: Map<string, DocElement[]>): Geometry {
  return el.type === 'clip' ? clipLocalGeometry(el, membersOf) : generateLocal(el)
}

/** A clip's local geometry: each non-mask member placed by its transform (recursing for nested
 *  clips, child pen stamped), clipped to the mask's boundary rings. Per-stroke pens preserved. */
export function clipLocalGeometry(clip: DocElement, membersOf: Map<string, DocElement[]>): Geometry {
  const members = membersOf.get(clip.id) ?? []
  const mask = members.find((m) => m.clipRole === 'mask')
  if (!mask) return []
  const rings = place(maskOutlineLocal(mask), mask.transform)
    .map((s) => s.points)
    .filter((pts) => pts.length >= 3)
  if (!rings.length) return []

  const out: Geometry = []
  for (const child of members) {
    if (child.clipRole === 'mask') continue
    const local = place(elementLocalGeometry(child, membersOf), child.transform)
    const stamped = isMultiPen(child.type) ? local : local.map((s) => ({ ...s, pen: child.pen }))
    out.push(...clipToPolygon(stamped, rings))
  }
  return out
}
