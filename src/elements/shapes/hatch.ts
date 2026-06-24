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
}

export const defaultHatch = (): Hatch => ({ pattern: 'none', spacing: 3, angle: 45 })

/** WASM pattern codes for the polygon-based fills (concentric is parametric, handled separately). */
const CODE: Record<'lines' | 'cross' | 'grid' | 'hilbert', number> = { lines: 0, cross: 1, grid: 2, hilbert: 3 }

const PATTERNS: HatchPattern[] = ['none', 'lines', 'cross', 'grid', 'concentric', 'hilbert']
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export function sanitizeHatch(raw: unknown): Hatch {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pattern = PATTERNS.includes(o.pattern as HatchPattern) ? (o.pattern as HatchPattern) : 'none'
  // Clamp spacing so an absurd density can't blow up generate().
  return { pattern, spacing: Math.max(0.3, num(o.spacing, 3)), angle: num(o.angle, 45) }
}

function polygonXy(points: Point[]): Float32Array {
  const xy = new Float32Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    xy[i * 2] = points[i].x
    xy[i * 2 + 1] = points[i].y
  }
  return xy
}

/** Line/cross/grid/hilbert fill clipped to the outline polygon. (concentric → caller maps to lines.) */
function polygonFill(outline: Point[], hatch: Hatch): Geometry {
  if (outline.length < 3) return []
  const key = hatch.pattern === 'concentric' ? 'lines' : (hatch.pattern as keyof typeof CODE)
  return hatchGeometry(polygonXy(outline), CODE[key], hatch.spacing, hatch.angle)
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

/** Closed paths: arbitrary-polygon concentric isn't supported, so it falls back to lines. */
export function pathFill(outline: Point[], hatch: Hatch): Geometry {
  if (hatch.pattern === 'none') return []
  return polygonFill(outline, hatch)
}
