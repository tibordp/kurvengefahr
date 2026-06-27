// Pipeline orchestration. Walks the document through the stages:
//
//   generate (per element, memoized, local mm)
//     → place   (local → page mm, via element.transform)
//     → filters (Stroke→Stroke; pressure shaping, etc. — empty in MVP)
//     → optimize (WASM; stroke ordering, page mm)
//     → emit    (page → machine + G-code string)
//
// The invalidation taxonomy maps onto these: text/params → re-generate; transform → re-place;
// feeds/preamble/Z → re-emit only.
import type { DocElement, Fiducial, Geometry, MachineProfile, Point } from '../types'
import { generateLocal, isElementLocked, isMultiPen } from '../../elements/registry'
import { place } from './place'
import { applyFilters, type StrokeFilter } from './filters'
import { optimizeGeometry } from './optimize'
import { emit } from './emit'
import { penParkInPage } from './toMachine'
import { clipToRegion, drawableRegion } from './clip'
import { clipLocalGeometry } from './clipGeometry'

/** Build page-space geometry for the whole document (generate + place + filters).
 *
 *  Grouping is assigned here, where elements are concatenated: a locked element (e.g. a
 *  handwriting element with global optimization off) gets a unique chain id and fixed
 *  direction, so the optimizer keeps its strokes in natural order as one unit. Everything else
 *  stays group 0 — free singletons in the global bag.
 *
 *  Pen assignment also happens here: each element's `pen` is stamped onto its strokes (so a pen
 *  change is a cheap re-place, never a regenerate). A natively multi-colour type (registry
 *  `multiPen`) keeps the per-stroke pens its generator produced. A locked chain is therefore
 *  single-pen — which is what the per-pen optimizer and the M0-per-pen emit assume. */
export function buildPageGeometry(
  elements: DocElement[],
  filters: StrokeFilter[] = [],
): Geometry {
  const out: Geometry = []
  let chainId = 0
  // Clip members (mask + clipped children) are handled via their clip, not at the top level.
  // Guard on the clip actually existing, so an orphaned member (clip deleted) still renders.
  const clipIds = new Set(elements.filter((e) => e.type === 'clip').map((e) => e.id))
  const membersOf = new Map<string, DocElement[]>()
  const memberIds = new Set<string>()
  for (const el of elements) {
    if (el.clipParent && clipIds.has(el.clipParent)) {
      memberIds.add(el.id)
      const arr = membersOf.get(el.clipParent) ?? []
      arr.push(el)
      membersOf.set(el.clipParent, arr)
    }
  }
  for (const el of elements) {
    if (memberIds.has(el.id)) continue // emitted via its clip
    if (el.type === 'clip') {
      // Geometry (children clipped to the mask) is already multi-pen; just place it on the page.
      for (const s of place(clipLocalGeometry(el, membersOf), el.transform)) out.push({ ...s })
      continue
    }
    const placed = place(generateLocal(el), el.transform)
    const filtered = applyFilters(placed, filters)
    const styled = el.dash && el.dash.dash > 0 && el.dash.gap > 0 ? dashGeometry(filtered, el.dash.dash, el.dash.gap) : filtered
    const stamp = isMultiPen(el.type) ? (s: (typeof styled)[number]) => s.pen : () => el.pen
    if (isElementLocked(el.type, el.params)) {
      chainId++
      for (const s of styled) out.push({ ...s, pen: stamp(s), group: chainId, reversible: false })
    } else {
      for (const s of styled) out.push({ ...s, pen: stamp(s) })
    }
  }
  return out
}

/** Break each stroke into `dash`-long marks separated by `gap` (mm), walking it by arc length. The
 *  on/off phase carries across vertices so the dashing is continuous along the whole polyline. */
function dashGeometry(strokes: Geometry, dash: number, gap: number): Geometry {
  const period = dash + gap
  const out: Geometry = []
  const lerp = (a: Point, b: Point, u: number): Point => ({
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    pressure: a.pressure,
  })
  for (const s of strokes) {
    if (s.points.length < 2) {
      out.push(s)
      continue
    }
    let phase = 0
    let cur: Point[] = []
    const flush = () => {
      if (cur.length >= 2) out.push({ ...s, points: cur })
      cur = []
    }
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]
      const b = s.points[i]
      const segLen = Math.hypot(b.x - a.x, b.y - a.y)
      if (segLen < 1e-9) continue
      let t = 0
      let guard = 0
      while (t < segLen - 1e-9 && guard++ < 1_000_000) {
        const on = phase < dash - 1e-9
        const boundary = on ? dash - phase : period - phase
        const take = Math.min(boundary, segLen - t)
        if (on) {
          if (cur.length === 0) cur.push(lerp(a, b, t / segLen))
          cur.push(lerp(a, b, (t + take) / segLen))
        }
        t += take
        phase += take
        if (phase >= period - 1e-9) phase -= period
        if (on && phase >= dash - 1e-9) flush() // turned off at a dash boundary
      }
    }
    flush()
  }
  return out
}

/** Page geometry clipped to what the pen can actually reach. Both Generate and Preview build
 *  on this so they agree on what gets plotted (and what's pruned). */
export function buildPlottableGeometry(
  elements: DocElement[],
  profile: MachineProfile,
  filters: StrokeFilter[] = [],
): Geometry {
  return clipToRegion(buildPageGeometry(elements, filters), drawableRegion(profile))
}

/** Full run: plottable geometry → optimize → G-code. */
export async function runPipeline(
  elements: DocElement[],
  profile: MachineProfile,
  filters: StrokeFilter[] = [],
  fiducial?: Fiducial | null,
): Promise<string> {
  const plottable = buildPlottableGeometry(elements, profile, filters)
  const penOrder = profile.pens.map((p) => p.id)
  const optimized = await optimizeGeometry(plottable, penParkInPage(profile), penOrder)
  return emit(optimized, profile, fiducial)
}
