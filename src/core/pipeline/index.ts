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
import type { DocElement, Geometry, MachineProfile } from '../types'
import { generateLocal, isElementLocked } from '../../elements/registry'
import { place } from './place'
import { applyFilters, type StrokeFilter } from './filters'
import { optimizeGeometry } from './optimize'
import { emit } from './emit'
import { penParkInPage } from './toMachine'
import { clipToRegion, drawableRegion } from './clip'

/** Build page-space geometry for the whole document (generate + place + filters).
 *
 *  Grouping is assigned here, where elements are concatenated: a locked element (e.g. a
 *  handwriting element with global optimization off) gets a unique chain id and fixed
 *  direction, so the optimizer keeps its strokes in natural order as one unit. Everything else
 *  stays group 0 — free singletons in the global bag. */
export function buildPageGeometry(
  elements: DocElement[],
  filters: StrokeFilter[] = [],
): Geometry {
  const out: Geometry = []
  let chainId = 0
  for (const el of elements) {
    const placed = place(generateLocal(el), el.transform)
    const filtered = applyFilters(placed, filters)
    if (isElementLocked(el.type, el.params)) {
      chainId++
      for (const s of filtered) out.push({ ...s, group: chainId, reversible: false })
    } else {
      for (const s of filtered) out.push(s)
    }
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
): Promise<string> {
  const plottable = buildPlottableGeometry(elements, profile, filters)
  const optimized = await optimizeGeometry(plottable, penParkInPage(profile))
  return emit(optimized, profile)
}
