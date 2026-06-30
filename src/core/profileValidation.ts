// Machine-profile validation. A profile that can't produce sane motion (zero bed, non-monotonic pen
// heights, …) must not emit G-code or plot — `validateProfile` is the single source of truth for
// that gate, used both to disable the UI actions and to guard the emission functions defensively.
import type { MachineProfile } from './types'

/** Human-readable problems with a profile; empty array = valid (safe to emit / plot). */
export function validateProfile(p: MachineProfile): string[] {
  const errs: string[] = []
  if (!(p.bed.width > 0) || !(p.bed.height > 0)) errs.push('Bed size must be greater than zero.')
  if (!(p.feeds.travel > 0)) errs.push('Travel feed must be greater than zero.')
  if (!(p.feeds.draw > 0)) errs.push('Draw feed must be greater than zero.')

  // Pen heights must descend: up (clearance) ≥ light ≥ full, and the pen must actually lift off the
  // page (up strictly above the down height), or the toolpath never leaves the medium.
  const { up, down, downLight } = p.penZ
  if (downLight === undefined) {
    if (!(up > down)) errs.push('Pen up Z must be above Pen down Z.')
  } else {
    if (!(up >= downLight && downLight >= down && up > down))
      errs.push('Pen heights must step down: Pen up, then down (light), then down (full).')
  }
  return errs
}
