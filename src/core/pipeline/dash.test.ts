import { describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM, type DocElement, type Geometry, type Stroke } from '../types'
import { applyDash, dashGeometry } from './dash'

const line = (over: Partial<Stroke> = {}): Stroke => ({
  points: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ],
  pen: 0,
  reversible: true,
  ...over,
})

const len = (s: Stroke) => {
  let l = 0
  for (let i = 1; i < s.points.length; i++)
    l += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y)
  return l
}

describe('dashGeometry', () => {
  it('breaks a straight stroke into dash-long marks separated by the gap', () => {
    const out = dashGeometry([line()], 2, 1) // 10 mm line, period 3 → marks at 0, 3, 6, 9
    expect(out).toHaveLength(4)
    expect(out.map((s) => s.points[0].x)).toEqual([0, 3, 6, 9])
    expect(out.slice(0, 3).map(len)).toEqual([2, 2, 2])
    expect(len(out[3])).toBeCloseTo(1) // the trailing partial mark
    for (const s of out) expect(len(s)).toBeLessThanOrEqual(2 + 1e-9)
  })

  it('carries the phase across vertices so dashing is continuous along the polyline', () => {
    // 3 mm across + 3 mm up, dash 2 / gap 2: the second mark spans the corner region [4, 6].
    const bent = line({ points: [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 3 }] })
    const out = dashGeometry([bent], 2, 2)
    expect(out).toHaveLength(2)
    expect(out[1].points[0]).toMatchObject({ x: 3, y: 1 })
    expect(out[1].points.at(-1)).toMatchObject({ x: 3, y: 3 })
  })

  it('preserves stroke metadata and pressure on every piece', () => {
    const src = line({ pen: 2, reversible: false, group: 7, points: [{ x: 0, y: 0, pressure: 0.7 }, { x: 10, y: 0, pressure: 0.7 }] })
    for (const s of dashGeometry([src], 2, 1)) {
      expect(s.pen).toBe(2)
      expect(s.reversible).toBe(false)
      expect(s.group).toBe(7)
      for (const p of s.points) expect(p.pressure).toBe(0.7)
    }
  })

  it('yields one whole piece when the dash exceeds the stroke length', () => {
    const out = dashGeometry([line()], 20, 5)
    expect(out).toHaveLength(1)
    expect(len(out[0])).toBeCloseTo(10)
  })

  it('passes degenerate strokes through unchanged', () => {
    const dot = line({ points: [{ x: 5, y: 5 }] })
    expect(dashGeometry([dot], 2, 1)).toEqual([dot])
  })
})

describe('applyDash', () => {
  const el = (dash?: DocElement['dash']): DocElement => ({
    id: 'e',
    type: 'path',
    transform: IDENTITY_TRANSFORM,
    params: {},
    pen: 0,
    ...(dash ? { dash } : {}),
  })
  const geom: Geometry = [line()]

  it('dashes only when both dash and gap are positive', () => {
    expect(applyDash(geom, el())).toBe(geom)
    expect(applyDash(geom, el({ dash: 0, gap: 1 }))).toBe(geom)
    expect(applyDash(geom, el({ dash: 2, gap: 0 }))).toBe(geom)
    expect(applyDash(geom, el({ dash: 2, gap: 1 }))).toHaveLength(4)
  })
})
