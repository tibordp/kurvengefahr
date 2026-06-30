// Pipeline orchestration. Walks the document through the stages:
//
//   generate (per element, memoized, local mm)
//     → filter (per element, Rust, local mm — the non-destructive filter stack, memoized)
//     → place  (local → page mm, via element.transform)
//     → optimize (WASM; stroke ordering, page mm)
//     → emit   (page → machine + G-code string)
//
// The invalidation taxonomy maps onto these: text/params → re-generate; filters/transform → re-place
// (re-filter); feeds/preamble/Z → re-emit only.
import type { DocElement, Fiducial, Geometry, MachineProfile } from '../types'
import { isContainer, isElementLocked, isMultiPen } from '../../elements/registry'
import { place } from './place'
import { optimizeGeometry } from './optimize'
import { emit } from './emit'
import { penParkInPage } from './toMachine'
import { clipToRegion, drawableRegion } from './clip'
import { elementLocalGeometry, filteredLocal } from './clipGeometry'
import { applyDash } from './dash'

/** Build page-space geometry for the whole document (generate + filter + place).
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
export function buildPageGeometry(elements: DocElement[]): Geometry {
  const out: Geometry = []
  let chainId = 0
  // Container members (group/clip children, incl. a clip's mask) are handled via their container, not
  // at the top level. Guard on the container existing, so an orphaned member (container deleted) still
  // renders. The members map is keyed by `parent` for both container kinds.
  const containerIds = new Set(elements.filter((e) => isContainer(e.type)).map((e) => e.id))
  const membersOf = new Map<string, DocElement[]>()
  const memberIds = new Set<string>()
  for (const el of elements) {
    if (el.parent && containerIds.has(el.parent)) {
      memberIds.add(el.id)
      const arr = membersOf.get(el.parent) ?? []
      arr.push(el)
      membersOf.set(el.parent, arr)
    }
  }
  for (const el of elements) {
    if (memberIds.has(el.id)) continue // emitted via its container
    if (isContainer(el.type)) {
      // Composed (group) / clipped (clip) member geometry — already filtered + multi-pen; just place.
      for (const s of place(elementLocalGeometry(el, membersOf), el.transform)) out.push({ ...s })
      continue
    }
    // Stamp the element's pressure onto its points here (page space), alongside pen below. Filters run
    // in local space (inside filteredLocal), before place — so the canvas shows exactly what plots.
    const elPressure = isMultiPen(el.type) ? undefined : el.pressure
    const styled = applyDash(place(filteredLocal(el), el.transform, elPressure), el)
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

/** Page geometry clipped to what the pen can actually reach. Both Generate and Preview build
 *  on this so they agree on what gets plotted (and what's pruned). */
export function buildPlottableGeometry(elements: DocElement[], profile: MachineProfile): Geometry {
  return clipToRegion(buildPageGeometry(elements), drawableRegion(profile))
}

/** Full run: plottable geometry → optimize → G-code. */
export async function runPipeline(
  elements: DocElement[],
  profile: MachineProfile,
  fiducial?: Fiducial | null,
): Promise<string> {
  const plottable = buildPlottableGeometry(elements, profile)
  const penOrder = profile.pens.map((p) => p.id)
  const optimized = await optimizeGeometry(plottable, penParkInPage(profile), penOrder)
  return emit(optimized, profile, fiducial)
}
