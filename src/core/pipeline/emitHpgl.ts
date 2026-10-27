// GRBL tape → HP-GL commands. The `.plt` download and the live streamer render segments through
// the same `hpglSegmentCommand`, so the file and the stream are the same job.
//
// Dialect notes (the HP-GL subset vinyl cutters understand):
//   • Plotter units: 40 per mm (0.025 mm), integers, absolute from the device's origin.
//     Coordinates are the tape's machine mm, so the origin flip already happened in toMachine.
//   • Every job opens with `IN;` — the SK-720T ignores all input until it has seen one.
//   • Every motion is its own `PU x,y;` / `PD x,y;` — one command per tape segment keeps the
//     streamer's pause/cancel granularity equal to the tape's.
//   • Cutters treat a gap in the data as the end of the job and drive back to their origin. Where
//     the head must wait in place (pauses, prompts, go-to-fiducial), the sender repeats
//     `hpglHoldCommand` — a move to where the head already is — to keep the job open.
//   • `VS`/`FS` only when set (> 0); otherwise the device's panel settings apply.
//   • Pauses have no HP-GL form. The file selects the next pen with `SP<n>` (n = the pen's slot,
//     1-based) — a multi-pen plotter swaps, a single-tool cutter ignores it; the streamer prompts.
import type { HpglProfile } from '../types'
import { SEG } from './planTypes'
import type { GrblTape } from './grblTape'

export const HPGL_UNITS_PER_MM = 40

/** How often to repeat the hold command — well inside the SK-720T's end-of-job gap. */
export const HPGL_HOLD_MS = 500

const pu = (mm: number) => Math.round(mm * HPGL_UNITS_PER_MM)

/** Tape segment `i` as one HP-GL command, or null for pause segments (the caller's business). */
export function hpglSegmentCommand(tape: GrblTape, i: number): string | null {
  switch (tape.kind[i]) {
    case SEG.motion:
      return `${tape.penDown[i] ? 'PD' : 'PU'}${pu(tape.x[i])},${pu(tape.y[i])};`
    case SEG.penDown:
      return 'PD;'
    case SEG.penUp:
      return 'PU;'
    default:
      return null
  }
}

/** A pen-up move to (x, y) machine mm. Repeated at the head's position, it holds the job open. */
export function hpglHoldCommand(x: number, y: number): string {
  return `PU${pu(x)},${pu(y)};`
}

export function hpglInitCommands(profile: HpglProfile): string[] {
  const cmds = ['IN;', 'SP1;']
  if (profile.speed > 0) cmds.push(`VS${profile.speed};`)
  if (profile.force > 0) cmds.push(`FS${profile.force};`)
  return cmds
}

/** The full download artifact. */
export function emitHpgl(tape: GrblTape, profile: HpglProfile): string {
  const cmds = hpglInitCommands(profile)
  for (let i = 0; i < tape.length; i++) {
    if (tape.kind[i] === SEG.pausePenswap) {
      const slot = profile.pens.findIndex((p) => p.id === tape.pen[i])
      cmds.push(`SP${slot + 1};`)
      continue
    }
    const c = hpglSegmentCommand(tape, i)
    if (c) cmds.push(c)
  }
  return cmds.join('\n') + '\n'
}
