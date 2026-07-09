// Stage: page mm → machine coordinates (the pen target). Plotter bugs live in this seam, so it
// is explicit. Page space is screen-like (origin top-left, +Y down). The machine may put (0,0)
// at the bottom-left (+Y up), which needs a Y-flip. No clamping here — geometry is clipped to
// the drawable region upstream (see clip.ts), and the pen-offset is applied in emit.
import { penOffsetOf, type Fiducial, type MachineProfile, type Point } from '../types'

/** Where the PEN sits after homing, in page space — used to seed stroke ordering and the
 *  preview's first travel, so both start from where the pen physically is. The nozzle homes to
 *  machine (0,0); the pen is at nozzle + offset, so pen park = (offset.x, offset.y) in machine
 *  coords, mapped to page space (Y flips for a bottom-left origin). An AxiDraw has no offset:
 *  park = machine (0,0), the corner the operator physically homes the carriage to. */
export function penParkInPage(profile: MachineProfile): { x: number; y: number } {
  const { x: ox, y: oy } = penOffsetOf(profile)
  return profile.origin === 'bottom-left'
    ? { x: ox, y: profile.bed.height - oy }
    : { x: ox, y: oy }
}

/** Where stroke ordering starts, in page space: with a fiducial set the machine travels there
 *  and pauses before the first stroke, so the pen begins plotting from the fiducial — the
 *  optimizer must pick the first stroke relative to it, not the park. Both the pipeline and the
 *  preview's optimizer call seed from this, so they agree on the order. */
export function plotStartInPage(profile: MachineProfile, fiducial?: Fiducial | null): { x: number; y: number } {
  return fiducial ?? penParkInPage(profile)
}

export function toMachine(p: Point, profile: MachineProfile): Point {
  const y = profile.origin === 'bottom-left' ? profile.bed.height - p.y : p.y
  return { x: p.x, y, pressure: p.pressure }
}
