// Dashed-stroke styling: break each stroke into `dash`-long marks separated by `gap` (mm), walking
// it by arc length. The on/off phase carries across vertices so the dashing is continuous along the
// whole polyline. Baked into geometry (not a render-time style) so it plots — and so a dashed member
// inside a container shows its dashes both on the canvas and in the G-code.
import type { Geometry, Point } from '../types'
import type { DocElement } from '../types'

export function dashGeometry(strokes: Geometry, dash: number, gap: number): Geometry {
  const period = dash + gap
  const out: Geometry = []
  const lerp = (a: Point, b: Point, u: number): Point => ({
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    pressure: a.pressure,
  })
  for (const s of strokes) {
    if (s.points.length < 2) {
      out.push(s)
      continue
    }
    let phase = 0
    let cur: Point[] = []
    const flush = () => {
      if (cur.length >= 2) out.push({ ...s, points: cur })
      cur = []
    }
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1]
      const b = s.points[i]
      const segLen = Math.hypot(b.x - a.x, b.y - a.y)
      if (segLen < 1e-9) continue
      let t = 0
      let guard = 0
      while (t < segLen - 1e-9 && guard++ < 1_000_000) {
        const on = phase < dash - 1e-9
        const boundary = on ? dash - phase : period - phase
        const take = Math.min(boundary, segLen - t)
        if (on) {
          if (cur.length === 0) cur.push(lerp(a, b, t / segLen))
          cur.push(lerp(a, b, (t + take) / segLen))
        }
        t += take
        phase += take
        if (phase >= period - 1e-9) phase -= period
        if (on && phase >= dash - 1e-9) flush() // turned off at a dash boundary
      }
    }
    flush()
  }
  return out
}

/** Apply an element's dashed style to its (placed) geometry, or return it unchanged. The single place
 *  the "has a usable dash" check lives, so top-level elements and container members style alike. */
export function applyDash(geom: Geometry, el: DocElement): Geometry {
  const d = el.dash
  return d && d.dash > 0 && d.gap > 0 ? dashGeometry(geom, d.dash, d.gap) : geom
}
