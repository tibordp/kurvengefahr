import { registerElement } from '../registry'
import { pathGeometry } from '../../core/wasm/shapes'
import type { Geometry, Point } from '../../core/types'
import { type Hatch, defaultHatch, sanitizeHatch, pathFill } from './hatch'

/** One path node: anchor (x,y) plus in/out control handles stored RELATIVE to the anchor. A
 *  corner / polyline node has zero-length handles. All in element-local mm. */
export interface PathNode {
  x: number
  y: number
  hinX: number
  hinY: number
  houtX: number
  houtY: number
}

/** One subpath: a sequence of nodes, open or closed. A `path` element holds one or more of these,
 *  so a single element can carry disjoint pieces and holes (closed contours fill together under
 *  even-odd parity, so a contour nested in another punches a hole). */
export interface Contour {
  nodes: PathNode[]
  closed: boolean
}

export interface PathParams {
  contours: Contour[]
  hatch: Hatch
}

export const defaultPathParams = (): PathParams => ({ contours: [], hatch: defaultHatch() })

/** A corner node (no handles) at (x,y). */
export const cornerNode = (x: number, y: number): PathNode => ({
  x,
  y,
  hinX: 0,
  hinY: 0,
  houtX: 0,
  houtY: 0,
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Concatenate every contour's nodes into the flat boundary buffers (6 floats/node), with a CSR
 *  `starts` array (node units) and per-contour `closed` flags. */
function contoursToFlat(contours: Contour[]): {
  flat: Float32Array
  starts: Uint32Array
  closed: Uint8Array
} {
  const total = contours.reduce((a, c) => a + c.nodes.length, 0)
  const flat = new Float32Array(total * 6)
  const starts = new Uint32Array(contours.length + 1)
  const closed = new Uint8Array(contours.length)
  let o = 0
  for (let ci = 0; ci < contours.length; ci++) {
    starts[ci] = o
    closed[ci] = contours[ci].closed ? 1 : 0
    for (const n of contours[ci].nodes) {
      flat[o * 6] = n.x
      flat[o * 6 + 1] = n.y
      flat[o * 6 + 2] = n.hinX
      flat[o * 6 + 3] = n.hinY
      flat[o * 6 + 4] = n.houtX
      flat[o * 6 + 5] = n.houtY
      o++
    }
  }
  starts[contours.length] = o
  return { flat, starts, closed }
}

/** Tessellate the given contours' boundaries (one stroke per contour, in order), no hatch fill.
 *  Used by boolean ops to recover a path's rings independent of its fill/stroke style. */
export function pathOutlineStrokes(contours: Contour[]): Geometry {
  const total = contours.reduce((a, c) => a + c.nodes.length, 0)
  if (total < 2) return []
  const { flat, starts, closed } = contoursToFlat(contours)
  return pathGeometry(flat, starts, closed, 0)
}

function coerceNodes(arr: unknown): PathNode[] {
  return Array.isArray(arr)
    ? arr.map((n: any) => ({
        x: num(n?.x, 0),
        y: num(n?.y, 0),
        hinX: num(n?.hinX, 0),
        hinY: num(n?.hinY, 0),
        houtX: num(n?.houtX, 0),
        houtY: num(n?.houtY, 0),
      }))
    : []
}

registerElement('path', {
  generate: (p: PathParams): Geometry => {
    const totalNodes = p.contours.reduce((a, c) => a + c.nodes.length, 0)
    if (totalNodes < 2) return []
    const { flat, starts, closed } = contoursToFlat(p.contours)
    // One stroke per contour, in order — so index i lines up with p.contours[i].
    const outlines = pathGeometry(flat, starts, closed, 0)
    // Closed contours fill together (even-odd → holes); open contours only stroke.
    const rings: Point[][] = p.contours
      .map((c, i) => (c.closed ? (outlines[i]?.points ?? []) : []))
      .filter((pts) => pts.length >= 3)
    const fill = rings.length ? pathFill(rings, p.hatch) : []
    const drawn = outlines.filter((s) => s.points.length >= 2)
    return [...(p.hatch.stroke ? drawn : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
    const contours: Contour[] = Array.isArray(o.contours)
      ? o.contours.map((c: any) => ({ nodes: coerceNodes(c?.nodes), closed: !!c?.closed }))
      : // A pre-multi-contour path stored {nodes, closed} at the top level — wrap it as one contour.
        Array.isArray(o.nodes)
        ? [{ nodes: coerceNodes(o.nodes), closed: !!o.closed }]
        : []
    return { contours, hatch: sanitizeHatch(o.hatch) } as PathParams
  },
  // Baking scale into a path keeps the sign (a flip is valid geometry); handles scale too.
  applyScale: (p: PathParams, sx, sy) => ({
    ...p,
    contours: p.contours.map((c) => ({
      ...c,
      nodes: c.nodes.map((n) => ({
        x: n.x * sx,
        y: n.y * sy,
        hinX: n.hinX * sx,
        hinY: n.hinY * sy,
        houtX: n.houtX * sx,
        houtY: n.houtY * sy,
      })),
    })),
  }),
})
