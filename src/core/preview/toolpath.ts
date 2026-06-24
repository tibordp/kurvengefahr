// Preview model: turn optimized page-space Geometry into a distance-parameterized sequence
// of moves — exactly the motion the machine performs. Between strokes the pen travels (up);
// along a stroke it draws (down, carrying per-point pressure). The playhead is a distance in
// mm along this path, so animation and manual scrubbing share one parameter.
import type { Geometry } from '../types'

export interface PreviewPoint {
  x: number
  y: number
  pressure: number
}

export interface Move {
  kind: 'travel' | 'draw'
  pts: PreviewPoint[]
  /** Arc length of this move (mm). */
  len: number
  /** Cumulative distance at the start of this move (mm). */
  start: number
  /** Pen id (draw moves only) for colouring. */
  pen?: number
}

export interface Toolpath {
  moves: Move[]
  total: number
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Build the ordered travel/draw path. `origin` is where the pen starts (machine park). If a
 *  `fiducial` page-point is given, the run begins with a travel over it (the real machine pauses
 *  there for alignment; the pause isn't a motion, so only the travel is shown). */
export function buildToolpath(
  geom: Geometry,
  origin = { x: 0, y: 0 },
  fiducial?: { x: number; y: number } | null,
): Toolpath {
  const moves: Move[] = []
  let cursor = { x: origin.x, y: origin.y }
  let cum = 0

  if (fiducial) {
    const fLen = dist(cursor, fiducial)
    moves.push({
      kind: 'travel',
      pts: [
        { x: cursor.x, y: cursor.y, pressure: 0 },
        { x: fiducial.x, y: fiducial.y, pressure: 0 },
      ],
      len: fLen,
      start: cum,
    })
    cum += fLen
    cursor = { x: fiducial.x, y: fiducial.y }
  }

  for (const s of geom) {
    if (s.points.length === 0) continue
    const head = s.points[0]

    // Pen-up travel to the stroke start.
    const tLen = dist(cursor, head)
    moves.push({
      kind: 'travel',
      pts: [
        { x: cursor.x, y: cursor.y, pressure: 0 },
        { x: head.x, y: head.y, pressure: 0 },
      ],
      len: tLen,
      start: cum,
    })
    cum += tLen

    // Pen-down draw along the stroke.
    const pts: PreviewPoint[] = s.points.map((p) => ({
      x: p.x,
      y: p.y,
      pressure: p.pressure ?? 1,
    }))
    let dLen = 0
    for (let i = 1; i < pts.length; i++) dLen += dist(pts[i - 1], pts[i])
    moves.push({ kind: 'draw', pts, len: dLen, start: cum, pen: s.pen })
    cum += dLen

    const last = pts[pts.length - 1]
    cursor = { x: last.x, y: last.y }
  }

  return { moves, total: cum }
}

export interface Sample {
  x: number
  y: number
  pressure: number
  penDown: boolean
}

/** Position (and pen state) at distance `d` along the path — drives the turtle marker. */
export function sampleAt(tp: Toolpath, d: number): Sample | null {
  if (tp.moves.length === 0) return null
  const target = Math.max(0, Math.min(d, tp.total))

  let move = tp.moves[tp.moves.length - 1]
  for (const m of tp.moves) {
    if (target <= m.start + m.len) {
      move = m
      break
    }
  }

  const local = target - move.start
  let acc = 0
  for (let i = 1; i < move.pts.length; i++) {
    const a = move.pts[i - 1]
    const b = move.pts[i]
    const segLen = dist(a, b)
    if (acc + segLen >= local || i === move.pts.length - 1) {
      const t = segLen > 0 ? (local - acc) / segLen : 0
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        penDown: move.kind === 'draw',
      }
    }
    acc += segLen
  }
  const last = move.pts[move.pts.length - 1]
  return { x: last.x, y: last.y, pressure: last.pressure, penDown: move.kind === 'draw' }
}
