import { registerElement } from '../registry'
import { pathGeometry } from '../../core/wasm/shapes'
import type { Geometry } from '../../core/types'
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

export interface PathParams {
  nodes: PathNode[]
  closed: boolean
  hatch: Hatch
}

export const defaultPathParams = (): PathParams => ({ nodes: [], closed: false, hatch: defaultHatch() })

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

function nodesToFlat(nodes: PathNode[]): Float32Array {
  const a = new Float32Array(nodes.length * 6)
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    a[i * 6] = n.x
    a[i * 6 + 1] = n.y
    a[i * 6 + 2] = n.hinX
    a[i * 6 + 3] = n.hinY
    a[i * 6 + 4] = n.houtX
    a[i * 6 + 5] = n.houtY
  }
  return a
}

registerElement('path', {
  generate: (p: PathParams): Geometry => {
    if (p.nodes.length < 2) return []
    const outline = pathGeometry(nodesToFlat(p.nodes), p.closed, 0)
    // Only closed paths fill; an open path is always just its stroke.
    if (!p.closed) return outline
    const fill = pathFill(outline[0]?.points ?? [], p.hatch)
    return [...(p.hatch.stroke ? outline : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
    const nodes: PathNode[] = Array.isArray(o.nodes)
      ? o.nodes.map((n: any) => ({
          x: num(n?.x, 0),
          y: num(n?.y, 0),
          hinX: num(n?.hinX, 0),
          hinY: num(n?.hinY, 0),
          houtX: num(n?.houtX, 0),
          houtY: num(n?.houtY, 0),
        }))
      : []
    return { nodes, closed: !!o.closed, hatch: sanitizeHatch(o.hatch) } as PathParams
  },
  // Baking scale into a path keeps the sign (a flip is valid geometry); handles scale too.
  applyScale: (p: PathParams, sx, sy) => ({
    ...p,
    nodes: p.nodes.map((n) => ({
      x: n.x * sx,
      y: n.y * sy,
      hinX: n.hinX * sx,
      hinY: n.hinY * sy,
      houtX: n.houtX * sx,
      houtY: n.houtY * sy,
    })),
  }),
})
