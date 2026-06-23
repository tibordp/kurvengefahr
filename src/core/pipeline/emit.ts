// Stage: Geometry (page mm) → G-code string. Trivial string building, plus the per-point
// page→machine mapping. Changing feeds/preamble/Z re-runs only this; geometry is untouched.
//
// Multi-pen is pre-installed: strokes are grouped by `pen` and an M0 pause is dropped
// between groups (a no-op when there is one pen). Feed resolution happens at the one point
// here: `stroke.feed ?? profile.feeds.draw` (per-element override is a future field).
import type { Geometry, MachineProfile, Stroke } from '../types'
import { toMachine } from './toMachine'

const f3 = (n: number) => n.toFixed(3)

export function emit(geom: Geometry, profile: MachineProfile): string {
  const lines: string[] = []
  const { penZ, feeds, penOffset: off } = profile

  // G-code commands the nozzle; the pen is offset from it, so subtract the offset from the
  // pen target. Geometry is already clipped to the reachable region, so coords stay in-bounds.
  const zUp = f3(penZ.up - off.z)
  const zDown = f3(penZ.down - off.z)
  const nozzle = (p: { x: number; y: number }) => {
    const m = toMachine(p, profile)
    return { x: f3(m.x - off.x), y: f3(m.y - off.y) }
  }

  if (profile.preamble.trim()) lines.push(profile.preamble.trim())

  // Group strokes by pen, preserving (already-optimized) order within each group.
  const byPen = new Map<number, Stroke[]>()
  for (const s of geom) {
    if (s.points.length === 0) continue
    const arr = byPen.get(s.pen) ?? []
    arr.push(s)
    byPen.set(s.pen, arr)
  }

  // Initial pen-up — part of the generated toolpath (not the preamble), so it honours the
  // profile's pen-up Z and the pen offset. After this the pen stays up between strokes, so each
  // stroke only needs to lift on exit; a manual pen change (M0) re-asserts it.
  if (byPen.size > 0) lines.push(`G0 Z${zUp}`)

  let firstGroup = true
  for (const [penId, strokes] of byPen) {
    if (!firstGroup) {
      lines.push(`M0 ; change to pen ${penId}`)
      lines.push(`G0 Z${zUp}`)
    }
    firstGroup = false

    for (const s of strokes) {
      const drawFeed = s.feed ?? feeds.draw
      const first = nozzle(s.points[0])

      // Travel to the start (pen already up), then pen down (+ dwell for the spring to settle).
      lines.push(`G0 X${first.x} Y${first.y} F${f3(feeds.travel)}`)
      lines.push(`G1 Z${zDown} F${f3(feeds.travel)}`)
      if (penZ.dwell > 0) lines.push(`G4 P${penZ.dwell}`)

      for (let i = 1; i < s.points.length; i++) {
        const p = nozzle(s.points[i])
        lines.push(`G1 X${p.x} Y${p.y} F${f3(drawFeed)}`)
      }

      // Pen up (+ dwell).
      lines.push(`G0 Z${zUp}`)
      if (penZ.dwell > 0) lines.push(`G4 P${penZ.dwell}`)
    }
  }

  if (profile.postamble.trim()) lines.push(profile.postamble.trim())

  return lines.join('\n') + '\n'
}
