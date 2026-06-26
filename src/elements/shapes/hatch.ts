// Hatch (fill) settings shared by all closed shapes, plus helpers that turn an outline + hatch
// into fill strokes via the Rust routines. `spacing` is the density (mm between lines/rings).
import { hatchGeometry, concentricGeometry } from '../../core/wasm/shapes'
import type { Geometry, Point } from '../../core/types'

export type HatchPattern = 'none' | 'lines' | 'cross' | 'grid' | 'concentric' | 'hilbert'

export interface Hatch {
  pattern: HatchPattern
  /** Line / ring spacing in mm — smaller is denser. */
  spacing: number
  /** Hatch angle in degrees (used by lines + cross). */
  angle: number
  /** Draw the outline. The invariant (enforced by {@link sanitizeHatch} + the inspector) is that a
   *  shape is never both strokeless and fill-less: `stroke=false` requires `pattern !== 'none'`. */
  stroke: boolean
}

export const defaultHatch = (): Hatch => ({ pattern: 'none', spacing: 3, angle: 45, stroke: true })

/** WASM pattern codes for the polygon-based fills. Rect/ellipse use the exact parametric
 *  `concentric` instead; arbitrary polygons (paths) fall through to the marching-squares one here. */
const CODE: Record<'lines' | 'cross' | 'grid' | 'concentric' | 'hilbert', number> = {
  lines: 0,
  cross: 1,
  grid: 2,
  hilbert: 3,
  concentric: 4,
}

const PATTERNS: HatchPattern[] = ['none', 'lines', 'cross', 'grid', 'concentric', 'hilbert']
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function sanitizeHatch(raw: unknown): Hatch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pattern = PATTERNS.includes(o.pattern as HatchPattern) ? (o.pattern as HatchPattern) : 'none'
  // A shape with no fill must keep its outline, else it makes no marks at all.
  const stroke = pattern === 'none' ? true : typeof o.stroke === 'boolean' ? o.stroke : true
  // Clamp spacing so an absurd density can't blow up generate().
  return { pattern, spacing: Math.max(0.3, num(o.spacing, 3)), angle: num(o.angle, 45), stroke }
}

function polygonXy(points: Point[]): Float32Array {
  const xy = new Float32Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    xy[i * 2] = points[i].x
    xy[i * 2 + 1] = points[i].y
  }
  return xy
}

/** Any polygon fill (lines/cross/grid/concentric/hilbert) clipped to the outline polygon. */
function polygonFill(outline: Point[], hatch: Hatch): Geometry {
  if (outline.length < 3) return []
  return hatchGeometry(polygonXy(outline), CODE[hatch.pattern as keyof typeof CODE], hatch.spacing, hatch.angle)
}

export function rectFill(w: number, h: number, outline: Point[], hatch: Hatch): Geometry {
  if (hatch.pattern === 'none') return []
  if (hatch.pattern === 'concentric') return concentricGeometry(0, w, h, hatch.spacing)
  return polygonFill(outline, hatch)
}

export function ellipseFill(rx: number, ry: number, outline: Point[], hatch: Hatch): Geometry {
  if (hatch.pattern === 'none') return []
  if (hatch.pattern === 'concentric') return concentricGeometry(1, rx, ry, hatch.spacing)
  return polygonFill(outline, hatch)
}

/** Closed paths: all patterns (incl. polygon concentric) go through the polygon fill. */
export function pathFill(outline: Point[], hatch: Hatch): Geometry {
  if (hatch.pattern === 'none') return []
  return polygonFill(outline, hatch)
}
