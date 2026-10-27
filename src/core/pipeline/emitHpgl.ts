// GRBL tape → HP-GL commands. The `.plt` download and the live streamer render segments through
// the same `hpglSegmentCommand`, so the file and the stream are the same job.
//
// Dialect notes (the HP-GL subset vinyl cutters understand):
//   • Plotter units: 40 per mm (0.025 mm), integers. Coordinates are the tape's machine mm, so
//     the origin flip already happened in toMachine.
//   • Every motion is its own `PU x,y;` / `PD x,y;` — one command per tape segment keeps the
//     streamer's pause/cancel granularity equal to the tape's.
//   • `startAt: 'head'` plots relative (`PR`): the job's (0,0) is wherever the head sits, and the
//     tape's walk home returns there. Deltas come from *cumulative* quantized positions, so
//     rounding never accumulates. `IN` is skipped in that mode — some devices reset their
//     position on it.
//   • `VS`/`FS` only when set (> 0); otherwise the device's panel settings apply.
//   • Pauses have no HP-GL form. The file selects the next pen with `SP<n>` (n = the pen's slot,
//     1-based) — a multi-pen plotter swaps, a single-tool cutter ignores it; the streamer prompts.
import type { HpglProfile } from '../types'
import { SEG } from './planTypes'
import type { GrblTape } from './grblTape'

export const HPGL_UNITS_PER_MM = 40

const pu = (mm: number) => Math.round(mm * HPGL_UNITS_PER_MM)

/** Per-job emit state: the last commanded position (plotter units) when plotting relative,
 *  null when absolute. Fresh per job (`newHpglCtx`). */
export type HpglCtx = { x: number; y: number } | null

export function newHpglCtx(profile: HpglProfile): HpglCtx {
  return profile.startAt === 'head' ? { x: 0, y: 0 } : null
}

/** A move's coordinate pair: absolute as-is, relative as the delta from the last position. */
function coords(x: number, y: number, ctx: HpglCtx): string {
  if (!ctx) return `${x},${y}`
  const d = `${x - ctx.x},${y - ctx.y}`
  ctx.x = x
  ctx.y = y
  return d
}

/** Tape segment `i` as one HP-GL command, or null for pause segments (the caller's business). */
export function hpglSegmentCommand(tape: GrblTape, i: number, ctx: HpglCtx): string | null {
  switch (tape.kind[i]) {
    case SEG.motion:
      return `${tape.penDown[i] ? 'PD' : 'PU'}${coords(pu(tape.x[i]), pu(tape.y[i]), ctx)};`
    case SEG.penDown:
      return 'PD;'
    case SEG.penUp:
      return 'PU;'
    default:
      return null
  }
}

/** Pen up and back to the job's (0,0) — the streamer's cancel. */
export function hpglHomeCommand(ctx: HpglCtx): string {
  return `PU;PU${coords(0, 0, ctx)};`
}

export function hpglInitCommands(profile: HpglProfile): string[] {
  const cmds = profile.startAt === 'head' ? ['SP1;', 'PR;'] : ['IN;', 'SP1;', 'PA;']
  if (profile.speed > 0) cmds.push(`VS${profile.speed};`)
  if (profile.force > 0) cmds.push(`FS${profile.force};`)
  return cmds
}

/** The full download artifact. */
export function emitHpgl(tape: GrblTape, profile: HpglProfile): string {
  const ctx = newHpglCtx(profile)
  const cmds = hpglInitCommands(profile)
  for (let i = 0; i < tape.length; i++) {
    if (tape.kind[i] === SEG.pausePenswap) {
      const slot = profile.pens.findIndex((p) => p.id === tape.pen[i])
      cmds.push(`SP${slot + 1};`)
      continue
    }
    const c = hpglSegmentCommand(tape, i, ctx)
    if (c) cmds.push(c)
  }
  return cmds.join('\n') + '\n'
}
