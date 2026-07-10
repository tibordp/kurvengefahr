// Pipeline orchestration. Walks the document through the stages:
//
//   generate (per element, memoized, local mm)
//     → effect (per element, Rust, local mm — the non-destructive effect stack, memoized)
//     → place  (local → page mm, via element.transform)
//     → optimize (WASM; stroke ordering, page mm)
//     → emit   (page → machine + G-code string)
//
// The invalidation taxonomy maps onto these: text/params → re-generate; effects/transform → re-place
// (re-effect); feeds/preamble/Z → re-emit only.
import type { DocElement, Fiducial, Geometry, MachineProfile } from '../types'
import { isContainer, isElementLocked, isMultiPen } from '../../elements/registry'
import { place } from './place'
import { optimizeGeometry } from './optimize'
import { emit } from './emit'
import { planAxidraw, type PlotPlan } from './plan'
import { planGrblTape, type GrblTape } from './grblTape'
import { plotStartInPage } from './toMachine'
import { clipToRegion, drawableRegion } from './clip'
import { elementLocalGeometry, effectedLocal } from './clipGeometry'
import { applyDash } from './dash'

/** Build page-space geometry for the whole document (generate + effect + place).
 *
 *  Grouping is assigned here, where elements are concatenated: a locked element (e.g. a
 *  handwriting element with global optimization off) gets a unique chain id and fixed
 *  direction, so the optimizer keeps its strokes in natural order as one unit. Everything else
 *  stays group 0 — free singletons in the global bag.
 *
 *  Pen assignment also happens here: each element's `pen` is stamped onto its strokes (so a pen
 *  change is a cheap re-place, never a regenerate). A natively multi-colour type (registry
 *  `multiPen`) keeps the per-stroke pens its generator produced. A chain must be single-pen (the
 *  per-pen optimizer and the M0-per-pen emit assume it), so a locked multi-pen element (e.g. a
 *  Logo program using `setpen`) becomes one chain per pen: drawing order is kept within each
 *  pen, while pen groups still plot in palette order — a pen change is a physical pause
 *  regardless, so cross-pen drawing order can't be honoured anyway. */
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
    if (el.hidden) continue // hidden elements (incl. containers) make no marks; a hidden clip mask
    // still clips its siblings because that happens inside the container composition, not here.
    if (isContainer(el.type)) {
      // Composed (group) / clipped (clip) member geometry — already effected + multi-pen; just place.
      for (const s of place(elementLocalGeometry(el, membersOf), el.transform)) out.push({ ...s })
      continue
    }
    // Stamp the element's pressure onto its points here (page space), alongside pen below. Effects run
    // in local space (inside effectedLocal), before place — so the canvas shows exactly what plots.
    const elPressure = isMultiPen(el.type) ? undefined : el.pressure
    const styled = applyDash(place(effectedLocal(el), el.transform, elPressure), el)
    const stamp = isMultiPen(el.type) ? (s: (typeof styled)[number]) => s.pen : () => el.pen
    if (isElementLocked(el.type, el.params)) {
      // One locked chain per pen (Map keeps insertion order, so in-pen drawing order is kept).
      const byPen = new Map<number, Geometry>()
      for (const s of styled) {
        const p = stamp(s)
        let run = byPen.get(p)
        if (!run) byPen.set(p, (run = []))
        run.push(s)
      }
      for (const [p, run] of byPen) {
        chainId++
        for (const s of run) out.push({ ...s, pen: p, group: chainId, reversible: false })
      }
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

/** What a full pipeline run produces, by machine kind: a G-code string to download/upload, an
 *  EBB motion plan for the streaming session, or a GRBL tape (which the download artifact and the
 *  streaming session both render). The live kinds also carry the optimized geometry, which feeds
 *  the plot playhead's toolpath — same input the plan was built from, so they agree. */
export type PipelineOutput =
  | { kind: 'gcode'; gcode: string }
  | { kind: 'axidraw'; plan: PlotPlan; optimized: Geometry }
  | { kind: 'grbl'; tape: GrblTape; optimized: Geometry }

/** Full run: plottable geometry → optimize → the machine-kind output (emit / plan). */
export async function runPipeline(
  elements: DocElement[],
  profile: MachineProfile,
  fiducial?: Fiducial | null,
): Promise<PipelineOutput> {
  const plottable = buildPlottableGeometry(elements, profile)
  const penOrder = profile.pens.map((p) => p.id)
  const optimized = await optimizeGeometry(plottable, plotStartInPage(profile, fiducial), penOrder)
  if (profile.kind === 'axidraw') {
    return { kind: 'axidraw', plan: await planAxidraw(optimized, profile, fiducial), optimized }
  }
  if (profile.kind === 'grbl') {
    return { kind: 'grbl', tape: planGrblTape(optimized, profile, fiducial), optimized }
  }
  return { kind: 'gcode', gcode: emit(optimized, profile, fiducial) }
}
