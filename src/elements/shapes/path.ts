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

/** Reverse a contour: nodes back-to-front, swapping each node's in/out handles. */
function reverseContour(c: Contour): Contour {
  return {
    closed: c.closed,
    nodes: c.nodes
      .slice()
      .reverse()
      .map((n) => ({ x: n.x, y: n.y, hinX: n.houtX, hinY: n.houtY, houtX: n.hinX, houtY: n.hinY })),
  }
}

/** Weld open contours whose endpoints coincide (within `tol` mm) into single continuous contours,
 *  preserving Bézier handles; a chain that loops back is closed (so it can fill). Closed contours
 *  pass through. Greedy from both ends, straightest continuation at a junction. */
export function weldContours(contours: Contour[], tol = 0.1): Contour[] {
  const out: Contour[] = []
  const open: Contour[] = []
  for (const c of contours) {
    if (c.closed || c.nodes.length < 2) out.push(c)
    else open.push(c)
  }
  if (open.length < 2) return contours

  const key = (n: PathNode) => `${Math.round(n.x / tol)},${Math.round(n.y / tol)}`
  // endpoint cell → [contour index, which end (0 = first node, 1 = last node)]
  const ends = new Map<string, [number, 0 | 1][]>()
  const push = (k: string, v: [number, 0 | 1]) => (ends.get(k) ?? ends.set(k, []).get(k)!).push(v)
  open.forEach((c, i) => {
    push(key(c.nodes[0]), [i, 0])
    push(key(c.nodes[c.nodes.length - 1]), [i, 1])
  })

  const used = new Array(open.length).fill(false)
  const norm = (x: number, y: number) => {
    const l = Math.hypot(x, y) || 1
    return { x: x / l, y: y / l }
  }
  // Pick the unused contour touching node `n` whose body best continues direction `dir`.
  const next = (n: PathNode, dir: { x: number; y: number }): [number, 0 | 1] | null => {
    const cands = (ends.get(key(n)) ?? []).filter(([i]) => !used[i])
    if (!cands.length) return null
    let best = cands[0]
    let bestScore = -Infinity
    for (const [i, e] of cands) {
      const ns = open[i].nodes
      const [a, b] = e === 0 ? [ns[0], ns[1]] : [ns[ns.length - 1], ns[ns.length - 2]]
      const d = norm(b.x - a.x, b.y - a.y)
      const score = d.x * dir.x + d.y * dir.y
      if (score > bestScore) {
        bestScore = score
        best = [i, e]
      }
    }
    return best
  }

  for (let seed = 0; seed < open.length; seed++) {
    if (used[seed]) continue
    used[seed] = true
    let chain = open[seed].nodes.map((n) => ({ ...n }))
    // Grow forward from the tail.
    for (;;) {
      const last = chain[chain.length - 1]
      const prev = chain[chain.length - 2]
      const hit = next(last, norm(last.x - prev.x, last.y - prev.y))
      if (!hit) break
      const [i, e] = hit
      used[i] = true
      const c = e === 1 ? reverseContour(open[i]) : open[i]
      last.houtX = c.nodes[0].houtX
      last.houtY = c.nodes[0].houtY
      for (let k = 1; k < c.nodes.length; k++) chain.push({ ...c.nodes[k] })
    }
    // Grow backward from the head.
    for (;;) {
      const first = chain[0]
      const second = chain[1]
      const hit = next(first, norm(first.x - second.x, first.y - second.y))
      if (!hit) break
      const [i, e] = hit
      used[i] = true
      const c = e === 0 ? reverseContour(open[i]) : open[i]
      const cl = c.nodes[c.nodes.length - 1]
      first.hinX = cl.hinX
      first.hinY = cl.hinY
      chain = c.nodes.slice(0, -1).map((n) => ({ ...n })).concat(chain)
    }
    // Close if the chain looped back to its start.
    let closed = false
    if (chain.length >= 3 && key(chain[0]) === key(chain[chain.length - 1])) {
      const tail = chain.pop()!
      chain[0].hinX = tail.hinX
      chain[0].hinY = tail.hinY
      closed = true
    }
    out.push({ nodes: chain, closed })
  }
  return out
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
  label: 'Path',
  describe: (p: PathParams) => {
    const nodeCount = p.contours.reduce((a, c) => a + c.nodes.length, 0)
    const closed = p.contours.length > 0 && p.contours.every((c) => c.closed)
    return `${closed ? 'Shape' : 'Path'} (${nodeCount})`
  },
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
