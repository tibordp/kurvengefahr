import { registerElement } from '../registry'
import { polygonGeometry } from '../../core/wasm/shapes'
import type { Geometry } from '../../core/types'
import { type Hatch, defaultHatch, sanitizeHatch, pathFill } from './hatch'

export interface PolygonParams {
  /** Radii in mm; the polygon is inscribed in this ellipse, centred at the local origin (0,0). */
  rx: number
  ry: number
  /** Vertex count (≥3). For a star, the number of points. */
  sides: number
  /** Render as a star: points alternate the outer radius with `innerRatio`×radius. */
  star: boolean
  /** Inner-radius fraction for a star (0..1). Ignored when `star` is false. */
  innerRatio: number
  hatch: Hatch
}

export const defaultPolygonParams = (rx = 20, ry = 20, star = false): PolygonParams => ({
  rx,
  ry,
  sides: star ? 5 : 6,
  star,
  innerRatio: 0.5,
  hatch: defaultHatch(),
})

/** Polygon/star vertices in local space (centred at origin, first vertex at top). Mirrors the Rust
 *  tessellation so the live draw preview matches what gets committed. */
export function polygonVertices(
  rx: number,
  ry: number,
  sides: number,
  star: boolean,
  innerRatio: number,
): { x: number; y: number }[] {
  const s = Math.max(3, Math.floor(sides))
  const ratio = Math.min(1, Math.max(0, innerRatio))
  const n = star ? s * 2 : s
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
    const r = star && i % 2 === 1 ? ratio : 1
    out.push({ x: rx * r * Math.cos(a), y: ry * r * Math.sin(a) })
  }
  return out
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

registerElement('polygon', {
  label: 'Polygon',
  describe: (p: PolygonParams) => (p.star ? 'Star' : null),
  generate: (p: PolygonParams): Geometry => {
    const rx = Math.max(0, p.rx)
    const ry = Math.max(0, p.ry)
    const sides = Math.max(3, Math.floor(p.sides))
    const outline = polygonGeometry(rx, ry, sides, p.star, p.innerRatio)
    const fill = pathFill([outline[0]?.points ?? []], p.hatch)
    return [...(p.hatch.stroke ? outline : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      rx: Math.max(0, num(o.rx, 20)),
      ry: Math.max(0, num(o.ry, 20)),
      sides: Math.max(3, Math.round(num(o.sides, 6))),
      star: o.star === true,
      innerRatio: Math.min(0.95, Math.max(0.05, num(o.innerRatio, 0.5))),
      hatch: sanitizeHatch(o.hatch),
    } as PolygonParams
  },
  applyScale: (p: PolygonParams, sx, sy) => ({ ...p, rx: p.rx * Math.abs(sx), ry: p.ry * Math.abs(sy) }),
})
