// Stage: Geometry (page mm) → GRBL tape. Unlike the AxiDraw plan (crate/plan.rs) there is NO
// motion planning here — GRBL's firmware plans acceleration and cornering itself; the tape is just
// the ordered list of moves and pen events that both outputs render to G-code lines (download and
// live streaming share it, so the file and the stream are the same job). Trivial walk + coordinate
// map, which is why this stage is TS, not Rust.
//
// Contracts shared with the AxiDraw tape:
//   • `dist` is the cumulative preview distance at each segment's end and shares
//     `buildToolpath`'s parameterization (fiducial travel and pen-up travel count, pen/pause
//     events don't, the final walk home doesn't) — so it drives the live playhead directly.
//   • `blockStart` marks safe pause points: the first travel of each stroke, where the pen is
//     already up and stopping sends is harmless. (No forced mid-stroke rests — a pause during a
//     very long stroke waits for it to finish.)
//   • pauses (fiducial / pen swap) are always preceded by a pen-up.
//
// Coordinates are MACHINE mm (page → machine via toMachine, Y-flip per origin), so the renderer
// emits them verbatim; distances are flip-invariant, so `dist` still matches the page-space
// preview toolpath. Work zero (0,0) is the job's origin — the session establishes it with
// `G10 L20` (or `$H`), and the tape both starts and ends there.
//
// Moves longer than MAX_SEG_MM are split: with character-counting flow control the RX buffer plus
// GRBL's planner queue hold ~25 lines of committed motion, so bounding each line's length bounds
// how long pause/cancel take to bite.
import type { Fiducial, Geometry, GrblProfile } from '../types'
import { toMachine } from './toMachine'
import { SEG } from './planTypes'

/** Longest single emitted move, mm (see header). */
export const MAX_SEG_MM = 50

/** The flat GRBL tape. Parallel typed arrays, one entry per segment. Motion segments carry their
 *  target (machine mm) and, for draws, the target pressure (0..1, for the Z-mode pressure ramp);
 *  pen/pause segments carry the position they happen at. `pen` is the active pen throughout. */
export interface GrblTape {
  kind: Uint8Array
  x: Float32Array
  y: Float32Array
  pressure: Float32Array
  /** 1 = this motion draws (pen is down), 0 = pen-up travel. Meaningful for `motion` only. */
  penDown: Uint8Array
  /** Per-stroke feed override (mm/min) for draw motions; 0 = the profile's draw feed. */
  feed: Float32Array
  dist: Float32Array
  pen: Uint16Array
  blockStart: Uint8Array
  totalDist: number
  length: number
}

interface TapeBuilder {
  kind: number[]
  x: number[]
  y: number[]
  pressure: number[]
  penDown: number[]
  feed: number[]
  dist: number[]
  pen: number[]
  blockStart: number[]
}

export function planGrblTape(geom: Geometry, profile: GrblProfile, fiducial?: Fiducial | null): GrblTape {
  const strokes = geom.filter((s) => s.points.length > 0)
  const b: TapeBuilder = {
    kind: [],
    x: [],
    y: [],
    pressure: [],
    penDown: [],
    feed: [],
    dist: [],
    pen: [],
    blockStart: [],
  }

  let cur = { x: 0, y: 0 } // work zero — where the job starts (and ends)
  let dist = 0
  let pen = strokes.length ? strokes[0].pen : 0

  const push = (kind: number, x: number, y: number, pressure: number, penDown: 0 | 1, feed: number, blockStart: 0 | 1) => {
    b.kind.push(kind)
    b.x.push(x)
    b.y.push(y)
    b.pressure.push(pressure)
    b.penDown.push(penDown)
    b.feed.push(feed)
    b.dist.push(dist)
    b.pen.push(pen)
    b.blockStart.push(blockStart)
  }

  /** One move from `cur` to the target, split into ≤ MAX_SEG_MM chunks (pressure interpolated
   *  from..to along it). `countsDist` is false only for the final walk home. */
  const move = (
    to: { x: number; y: number },
    opts: { penDown: 0 | 1; pFrom?: number; pTo?: number; feed?: number; blockStart?: boolean; countsDist?: boolean },
  ) => {
    const len = Math.hypot(to.x - cur.x, to.y - cur.y)
    const chunks = Math.max(1, Math.ceil(len / MAX_SEG_MM))
    const from = cur
    const { pFrom = 0, pTo = 0, countsDist = true } = opts
    for (let c = 1; c <= chunks; c++) {
      const t = c / chunks
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      if (countsDist) dist += len / chunks
      push(SEG.motion, x, y, pFrom + (pTo - pFrom) * t, opts.penDown, opts.feed ?? 0, opts.blockStart && c === 1 ? 1 : 0)
    }
    cur = { x: to.x, y: to.y }
  }

  if (strokes.length === 0 && !fiducial) {
    return finish(b, dist)
  }

  // Known pen state before anything moves.
  push(SEG.penUp, cur.x, cur.y, 0, 0, 0, 0)

  if (fiducial && strokes.length > 0) {
    const f = toMachine(fiducial, profile)
    move(f, { penDown: 0 })
    push(SEG.pauseFiducial, cur.x, cur.y, 0, 0, 0, 0)
  }

  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i]
    if (i > 0 && s.pen !== pen) {
      pen = s.pen
      // Pen is up (every stroke ends with penUp); the swap happens wherever the last stroke ended.
      push(SEG.pausePenswap, cur.x, cur.y, 0, 0, 0, 0)
    }
    const pts = s.points.map((p) => toMachine(p, profile))
    const p0 = s.points[0].pressure ?? 1
    move(pts[0], { penDown: 0, blockStart: true })
    push(SEG.penDown, cur.x, cur.y, p0, 1, 0, 0)
    for (let j = 1; j < pts.length; j++) {
      move(pts[j], {
        penDown: 1,
        pFrom: s.points[j - 1].pressure ?? 1,
        pTo: s.points[j].pressure ?? 1,
        feed: s.feed ?? 0,
      })
    }
    push(SEG.penUp, cur.x, cur.y, 0, 0, 0, 0)
  }

  // Walk home to work zero — real motion, but past the end of the preview toolpath, so it
  // doesn't advance `dist` (same contract as the AxiDraw plan).
  move({ x: 0, y: 0 }, { penDown: 0, countsDist: false })

  return finish(b, dist)
}

function finish(b: TapeBuilder, totalDist: number): GrblTape {
  return {
    kind: Uint8Array.from(b.kind),
    x: Float32Array.from(b.x),
    y: Float32Array.from(b.y),
    pressure: Float32Array.from(b.pressure),
    penDown: Uint8Array.from(b.penDown),
    feed: Float32Array.from(b.feed),
    dist: Float32Array.from(b.dist),
    pen: Uint16Array.from(b.pen),
    blockStart: Uint8Array.from(b.blockStart),
    totalDist,
    length: b.kind.length,
  }
}
