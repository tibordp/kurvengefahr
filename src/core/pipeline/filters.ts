// Stroke → Stroke filters: pure post-`generate()` geometry massaging. Pressure shaping
// lives here. The pipeline runs a (possibly empty) filter chain, so adding realism passes
// later needs no schema change — just another `StrokeFilter`.
import type { Geometry, Stroke } from '../types'

export type StrokeFilter = (s: Stroke) => Stroke

export function applyFilters(geom: Geometry, filters: StrokeFilter[]): Geometry {
  if (filters.length === 0) return geom
  return geom.map((s) => filters.reduce((acc, f) => f(acc), s))
}

/** Taper pressure to zero over the final `lengthMm` of a stroke, so the pen lifts
 *  gradually instead of stamping a blob at the end. Pure illustration of the seam. */
export function penLiftTaper(lengthMm: number): StrokeFilter {
  return (s) => {
    const pts = s.points
    if (pts.length < 2) return s
    // Cumulative arc length from the end.
    let acc = 0
    const next = pts.map((p) => ({ ...p }))
    for (let i = pts.length - 1; i > 0; i--) {
      const dx = pts[i].x - pts[i - 1].x
      const dy = pts[i].y - pts[i - 1].y
      acc += Math.hypot(dx, dy)
      if (acc >= lengthMm) break
      const t = acc / lengthMm // 0 at the very end-ish, 1 at the taper boundary
      const base = next[i].pressure ?? 1
      next[i] = { ...next[i], pressure: base * t }
    }
    return { ...s, points: next }
  }
}
