// Container geometry + the non-destructive filter stage. A container (`group`/`clip`) has no
// registered generator; its local geometry is its members composed together — a group unions them,
// a clip additionally clips them to a mask member — each member placed by its own container-local
// transform (recursing, pen stamped). `place(…, container.transform)` in buildPageGeometry then
// lifts it to the page, so the container transforms as one nested object.
//
// `filteredLocal` is the single accessor everything that composes/plots/renders uses: it takes the
// pre-filter base geometry (a generator's output, or a container composition of already-filtered
// members) and applies the element's own filter stack (Rust). So a member's filters apply inside its
// container, then the container's filters apply over the combined result — a group/clip warp is one
// coherent field. `elementLocalGeometry` is an alias for it.
import type { DocElement, Geometry, Point } from '../types'
import { generateLocal, getFilterCache, isMultiPen, setFilterCache } from '../../elements/registry'
import { place } from './place'
import { clipToPolygon } from './clip'
import { applyFiltersWasm } from '../wasm/filters'
import { applyDash } from './dash'
import { rectGeometry, ellipseGeometry } from '../wasm/shapes'
import { pathOutlineStrokes, type RectParams, type EllipseParams, type PathParams } from '../../elements/shapes'

const CLOSE_EPS = 1e-3
const isClosed = (s: { points: Point[] }) =>
  s.points.length >= 3 &&
  Math.hypot(s.points[0].x - s.points[s.points.length - 1].x, s.points[0].y - s.points[s.points.length - 1].y) < CLOSE_EPS

const NO_MEMBERS: Map<string, DocElement[]> = new Map()

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

/** Pre-filter local geometry: a `clip` computes its clipped composition, a `group` its plain
 *  composition (members placed by their container-local transforms, recursing — each already
 *  filtered), everything else uses its registered generator. Exported for the ghost wireframe, which
 *  shows this un-warped shape under a filtered element. */
export function baseLocal(el: DocElement, membersOf: Map<string, DocElement[]> = NO_MEMBERS): Geometry {
  if (el.type === 'clip') return clipLocalGeometry(el, membersOf)
  if (el.type === 'group') return groupLocalGeometry(el, membersOf)
  return generateLocal(el)
}

/** Filtered local geometry — what the canvas shows and the pipeline plots. Applies the element's
 *  filter stack (Rust) to its base geometry, memoized while the base ref and the `filters` array ref
 *  are both unchanged (so unrelated re-renders skip the filter pass). Returns the base untouched when
 *  there are no enabled filters. `membersOf` is only needed for containers. */
export function filteredLocal(el: DocElement, membersOf: Map<string, DocElement[]> = NO_MEMBERS): Geometry {
  const base = baseLocal(el, membersOf)
  const filters = el.filters
  if (!filters || !filters.some((f) => f.enabled)) return base
  const hit = getFilterCache(el.id)
  if (hit && hit.base === base && hit.filters === filters) return hit.geom
  const geom = applyFiltersWasm(base, filters)
  setFilterCache(el.id, { base, filters, geom })
  return geom
}

/** The local geometry callers compose/plot/render with — filtered. */
export const elementLocalGeometry = filteredLocal

/** A group's local geometry: each member placed by its (group-local) transform, the member's pen
 *  stamped on (unless the member is itself multi-pen), recursing for nested containers. No mask —
 *  just the union, ready for `place(…, group.transform)` in the pipeline / on the canvas. */
export function groupLocalGeometry(group: DocElement, membersOf: Map<string, DocElement[]>): Geometry {
  const out: Geometry = []
  for (const child of membersOf.get(group.id) ?? []) {
    const childPressure = isMultiPen(child.type) ? undefined : child.pressure
    const local = applyDash(place(elementLocalGeometry(child, membersOf), child.transform, childPressure), child)
    const stamped = isMultiPen(child.type) ? local : local.map((s) => ({ ...s, pen: child.pen }))
    out.push(...stamped)
  }
  return out
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
    const childPressure = isMultiPen(child.type) ? undefined : child.pressure
    const local = applyDash(place(elementLocalGeometry(child, membersOf), child.transform, childPressure), child)
    const stamped = isMultiPen(child.type) ? local : local.map((s) => ({ ...s, pen: child.pen }))
    out.push(...clipToPolygon(stamped, rings))
  }
  return out
}
