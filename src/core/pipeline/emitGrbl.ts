// GRBL tape → G-code lines. The download artifact and the live streamer render segments through
// the same `grblSegmentLines`, so the file and the stream are the same job — they differ only at
// pause segments (pause macro text vs. an in-app prompt) and in who runs `$H`/`$X` (generated here
// for the file; the session handles alarms interactively).
//
// Dialect notes (vanilla GRBL 1.1):
//   • Travels are `G0` rapids (no F — GRBL rapids at $110/$111). Draws are `G1 … F`, with F
//     emitted only when it changes (modal): shorter lines mean more of them fit the 127-byte
//     RX window when streaming.
//   • Z-mode pen: `G1 Z<down> F<travel>` / `G0 Z<up>`, with the optional pressure ramp emitting
//     a Z only when the interpolated height changes — exactly emit.ts's contract.
//   • Servo-mode pen: `M3 S<val>` + `G4 P<seconds>` settle dwell; `M5` at job end.
//   • Work zero: `G10 L20 P1 X0 Y0 Z0` (survives the soft reset that cancel uses, unlike `G92`).
//     Emitted in BOTH homing modes — with homing the work origin is then the home corner, without
//     it it's wherever the operator parked. The tape starts and ends at (0,0) in these coords.
import type { GrblProfile } from '../types'
import { pauseLines } from './emit'
import { SEG } from './planTypes'
import type { GrblTape } from './grblTape'

const f3 = (n: number) => n.toFixed(3)

/** Modal G-code state threaded through a job's segments. Fresh per job (`newEmitCtx`). */
export interface GrblEmitCtx {
  lastF: string | null
  lastZ: string | null
}

export function newEmitCtx(): GrblEmitCtx {
  return { lastF: null, lastZ: null }
}

/** Pen-down Z for a pressure (0..1) in Z mode — downLight present ⇒ interpolate light→full. */
function penDownZ(pen: { up: number; down: number; downLight?: number }, p: number): string {
  const light = pen.downLight
  const z = light === undefined ? pen.down : light + (pen.down - light) * Math.min(1, Math.max(0, p))
  return f3(z)
}

/** Pen up/down as G-code lines (Z move or servo `M3 S` + settle dwell). Exported for the
 *  streaming session's pause/cancel recovery, which lifts the pen outside the tape. */
export function grblPenLines(profile: GrblProfile, dir: 'down' | 'up', pressure: number, ctx: GrblEmitCtx): string[] {
  const pen = profile.pen
  if (pen.mode === 'z') {
    if (dir === 'up') {
      ctx.lastZ = f3(pen.up)
      return [`G0 Z${ctx.lastZ}`]
    }
    ctx.lastZ = penDownZ(pen, pressure)
    ctx.lastF = f3(profile.feeds.travel)
    return [`G1 Z${ctx.lastZ} F${ctx.lastF}`]
  }
  const s = dir === 'down' ? pen.downS : pen.upS
  const settleMs = dir === 'down' ? pen.lowerMs : pen.raiseMs
  const lines = [`M3 S${Math.round(s)}`]
  if (settleMs > 0) lines.push(`G4 P${(settleMs / 1000).toFixed(3)}`)
  return lines
}

/** Render tape segment `i` to its G-code line(s). Pause segments render to nothing — the download
 *  artifact substitutes the pause macro, the streamer an in-app prompt. */
export function grblSegmentLines(tape: GrblTape, i: number, profile: GrblProfile, ctx: GrblEmitCtx): string[] {
  switch (tape.kind[i]) {
    case SEG.motion: {
      const xy = `X${f3(tape.x[i])} Y${f3(tape.y[i])}`
      if (!tape.penDown[i]) return [`G0 ${xy}`]
      // Pressure ramp: only Z mode with downLight set varies Z along a stroke; emit Z only when
      // the interpolated height changes (constant-pressure strokes emit none — pen-down set it).
      let zPart = ''
      if (profile.pen.mode === 'z' && profile.pen.downLight !== undefined) {
        const z = penDownZ(profile.pen, tape.pressure[i])
        if (z !== ctx.lastZ) {
          zPart = ` Z${z}`
          ctx.lastZ = z
        }
      }
      const f = f3(tape.feed[i] || profile.feeds.draw)
      const fPart = f !== ctx.lastF ? ` F${f}` : ''
      if (fPart) ctx.lastF = f
      return [`G1 ${xy}${zPart}${fPart}`]
    }
    case SEG.penDown:
      return grblPenLines(profile, 'down', tape.pressure[i], ctx)
    case SEG.penUp:
      return grblPenLines(profile, 'up', 0, ctx)
    default:
      return [] // pauses — the caller's business
  }
}

/** Job-setup lines, generated (not user preamble) because they depend on the homing toggle and
 *  pen mode. `$X` is deliberately absent — a file can't branch on alarm state; the live session
 *  unlocks interactively instead (and homes itself too, passing `includeHome: false` so `$H`
 *  doesn't run twice). */
export function grblInitLines(profile: GrblProfile, includeHome = profile.homing): string[] {
  const lines: string[] = []
  if (includeHome) lines.push('$H')
  lines.push('G21', 'G90', 'G54')
  lines.push('G10 L20 P1 X0 Y0 Z0')
  // No pen-up here — the tape always opens with its own penUp segment, before any motion.
  return lines
}

export function grblEndLines(profile: GrblProfile): string[] {
  return profile.pen.mode === 'servo' ? ['M5'] : []
}

/** The full download artifact. */
export function emitGrbl(tape: GrblTape, profile: GrblProfile): string {
  const ctx = newEmitCtx()
  const lines: string[] = []
  if (profile.preamble.trim()) lines.push(profile.preamble.trim())
  lines.push(...grblInitLines(profile))
  const penName = (id: number) => profile.pens.find((p) => p.id === id)?.name ?? `pen ${id}`
  for (let i = 0; i < tape.length; i++) {
    if (tape.kind[i] === SEG.pauseFiducial) {
      lines.push(...pauseLines(profile.pause, 'Align medium to fiducial'))
    } else if (tape.kind[i] === SEG.pausePenswap) {
      lines.push(...pauseLines(profile.pause, `Change to ${penName(tape.pen[i])}`))
    } else {
      lines.push(...grblSegmentLines(tape, i, profile, ctx))
    }
  }
  lines.push(...grblEndLines(profile))
  if (profile.postamble.trim()) lines.push(profile.postamble.trim())
  return lines.join('\n') + '\n'
}
