// Stage: Geometry (page mm) → G-code string. Trivial string building, plus the per-point
// page→machine mapping. Changing feeds/preamble/Z re-runs only this; geometry is untouched.
//
// Multi-pen: strokes are grouped by `pen`, plotted in the profile's palette order, and the
// profile's `pause` macro is dropped between groups (a no-op when there is one pen) so the operator
// can swap pens. The same pause macro is reused for the fiducial alignment stop. Feed resolution
// happens at the one point here: `stroke.feed ?? profile.feeds.draw` (per-element override later).
import type { Fiducial, Geometry, PrusaProfile, Stroke } from '../types'
import { toMachine } from './toMachine'

const f3 = (n: number) => n.toFixed(3)

/** Clearance height (mm) the pen lifts to before an operator pause (pen swap / fiducial). High and
 *  raw (not pen-offset-adjusted), matching the postamble's clearance lift. The *move* — this lift,
 *  not the pause macro — is emitted by `emit`. */
const CLEARANCE_Z = 30

/** The operator-pause macro lines with `{message}` filled in. Empty template → no lines. */
function pauseLines(template: string, message: string): string[] {
  const text = template.replaceAll('{message}', message).trim()
  return text ? text.split('\n') : []
}

export function emit(geom: Geometry, profile: PrusaProfile, fiducial?: Fiducial | null): string {
  const lines: string[] = []
  const { penZ, feeds, penOffset: off } = profile

  // G-code commands the nozzle; the pen is offset from it, so subtract the offset from the
  // pen target. Geometry is already clipped to the reachable region, so coords stay in-bounds.
  const zUp = f3(penZ.up - off.z)
  // Pen-down Z for a point's pressure (0..1). With pressure on (downLight set), interpolate
  // downLight (light) → down (full); off, every point uses the single `down`. Pressure is usually
  // constant along a stroke (one stamped element value) → one Z at pen-down; a variable-pressure
  // stroke (raster `pressurehatch`) ramps Z per point below.
  const penDownZ = (p: number) => {
    const light = penZ.downLight
    const z = light === undefined ? penZ.down : light + (penZ.down - light) * Math.min(1, Math.max(0, p))
    return f3(z - off.z)
  }
  const nozzle = (p: { x: number; y: number }) => {
    const m = toMachine(p, profile)
    return { x: f3(m.x - off.x), y: f3(m.y - off.y) }
  }

  // Group strokes by pen, preserving (already-optimized) order within each group.
  const byPen = new Map<number, Stroke[]>()
  for (const s of geom) {
    if (s.points.length === 0) continue
    const arr = byPen.get(s.pen) ?? []
    arr.push(s)
    byPen.set(s.pen, arr)
  }

  // Plot pens in the profile's palette order (predictable manual swaps); the optimizer already
  // ordered them this way, but enforce it here too so emit is correct independent of input order.
  // Any stray pen not in the palette (shouldn't happen) goes last, in first-appearance order.
  const palette = profile.pens.map((p) => p.id).filter((id) => byPen.has(id))
  const strays = [...byPen.keys()].filter((id) => !profile.pens.some((p) => p.id === id))
  const order = [...palette, ...strays]

  if (profile.preamble.trim()) lines.push(profile.preamble.trim())

  // Fiducial alignment: before any pen work, lift to clearance, travel over the alignment point,
  // then run the operator-pause macro to register the medium. The XY uses the same pen→nozzle
  // transform as strokes (toMachine − offset); only meaningful when there's something to plot.
  if (fiducial && order.length > 0) {
    const fid = nozzle(fiducial)
    lines.push(`G0 Z${f3(CLEARANCE_Z)} ; fiducial: clearance`)
    lines.push(`G0 X${fid.x} Y${fid.y} F${f3(feeds.travel)} ; fiducial: align point`)
    lines.push(...pauseLines(profile.pause, 'Align medium to fiducial'))
  }

  // Initial pen-up — part of the generated toolpath (not the preamble), so it honours the
  // profile's pen-up Z and the pen offset. After this the pen stays up between strokes, so each
  // stroke only needs to lift on exit; a pen change re-asserts it.
  if (order.length > 0) lines.push(`G0 Z${zUp}`)

  const penName = (id: number) => profile.pens.find((p) => p.id === id)?.name ?? `pen ${id}`

  let plotted = 0
  for (const penId of order) {
    const strokes = byPen.get(penId)!
    plotted++
    if (plotted > 1) {
      // Manual pen swap: lift to clearance (the move), run the pause macro ("Change to <pen>"),
      // then re-assert working pen-up Z before travelling. (Single-pen jobs never reach here.)
      lines.push(`G0 Z${f3(CLEARANCE_Z)} ; lift for pen change`)
      lines.push(...pauseLines(profile.pause, `Change to ${penName(penId)}`))
      lines.push(`G0 Z${zUp}`)
    }

    for (const s of strokes) {
      const drawFeed = s.feed ?? feeds.draw
      const first = nozzle(s.points[0])
      let prevZ = penDownZ(s.points[0].pressure ?? 1)

      // Travel to the start (pen already up), then pen down.
      lines.push(`G0 X${first.x} Y${first.y} F${f3(feeds.travel)}`)
      lines.push(`G1 Z${prevZ} F${f3(feeds.travel)}`)

      for (let i = 1; i < s.points.length; i++) {
        const p = nozzle(s.points[i])
        // Ramp the pen-down Z only when the point's pressure actually changes: constant-pressure
        // strokes (every element but a variable-pressure one — and any stroke when pressure is off)
        // emit no per-point Z, so output is unchanged. When it does change, the plotter interpolates
        // Z linearly across the move → a smooth pressure ramp along the segment.
        const z = penDownZ(s.points[i].pressure ?? 1)
        const zPart = z !== prevZ ? ` Z${z}` : ''
        lines.push(`G1 X${p.x} Y${p.y}${zPart} F${f3(drawFeed)}`)
        prevZ = z
      }

      // Pen up.
      lines.push(`G0 Z${zUp}`)
    }
  }

  if (profile.postamble.trim()) lines.push(profile.postamble.trim())

  return lines.join('\n') + '\n'
}
