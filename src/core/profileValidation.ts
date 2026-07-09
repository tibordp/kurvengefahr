// Machine-profile validation. A profile that can't produce sane motion (zero bed, non-monotonic pen
// heights, …) must not emit G-code or plot — `validateProfile` is the single source of truth for
// that gate, used both to disable the UI actions and to guard the emission functions defensively.
import type { MachineProfile } from './types'

/** Human-readable problems with a profile; empty array = valid (safe to emit / plot). */
export function validateProfile(p: MachineProfile): string[] {
  const errs: string[] = []
  if (!(p.bed.width > 0) || !(p.bed.height > 0)) errs.push('Bed size must be greater than zero.')

  if (p.kind === 'prusa') {
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

  if (p.kind === 'grbl') {
    if (!(p.baudRate > 0)) errs.push('Baud rate must be greater than zero.')
    if (!(p.feeds.travel > 0)) errs.push('Travel feed must be greater than zero.')
    if (!(p.feeds.draw > 0)) errs.push('Draw feed must be greater than zero.')
    if (p.pen.mode === 'z') {
      // Same monotonicity as the prusa pen: up (clearance) ≥ light ≥ full, with a real lift.
      const { up, down, downLight } = p.pen
      if (downLight === undefined) {
        if (!(up > down)) errs.push('Pen up Z must be above Pen down Z.')
      } else {
        if (!(up >= downLight && downLight >= down && up > down))
          errs.push('Pen heights must step down: Pen up, then down (light), then down (full).')
      }
    } else {
      // Spindle-PWM servo: S is capped by GRBL's $30 (default 1000); two distinct positions or the
      // pen never lifts.
      const { upS, downS, raiseMs, lowerMs } = p.pen
      const s = (v: number) => v >= 0 && v <= 1000
      if (!s(upS) || !s(downS)) errs.push('Servo S values must be between 0 and 1000.')
      else if (upS === downS) errs.push('Servo up and down S values must differ.')
      if (!(raiseMs >= 0) || !(lowerMs >= 0)) errs.push('Servo delays must be zero or more.')
    }
    return errs
  }

  // axidraw: the motion planner needs positive limits, and the servo needs two distinct positions
  // or the pen never actually lifts.
  if (!(p.motion.drawSpeed > 0)) errs.push('Draw speed must be greater than zero.')
  if (!(p.motion.travelSpeed > 0)) errs.push('Travel speed must be greater than zero.')
  if (!(p.motion.acceleration > 0)) errs.push('Acceleration must be greater than zero.')
  if (!(p.motion.cornering >= 0)) errs.push('Cornering must be zero or more.')
  const { upPercent, downPercent, liftMs, dropMs } = p.servo
  const pct = (v: number) => v >= 0 && v <= 100
  if (!pct(upPercent) || !pct(downPercent)) errs.push('Servo positions must be between 0 and 100%.')
  else if (upPercent === downPercent) errs.push('Servo up and down positions must differ.')
  if (!(liftMs >= 0) || !(dropMs >= 0)) errs.push('Servo delays must be zero or more.')
  return errs
}
