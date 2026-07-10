// The preview's distance parameterization — the same dist contract the plan/tape playhead uses.
import { describe, expect, it } from 'vitest'
import type { Geometry } from '../types'
import { buildToolpath, sampleAt } from './toolpath'

const geom: Geometry = [
  {
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
    pen: 0,
    reversible: true,
  },
  {
    points: [
      { x: 10, y: 5 },
      { x: 10, y: 15 },
    ],
    pen: 1,
    reversible: true,
  },
]
// From the origin: travel 0, draw 10, travel 5, draw 10 → total 25.

describe('buildToolpath', () => {
  it('alternates travel/draw with cumulative starts and the summed total', () => {
    const tp = buildToolpath(geom)
    expect(tp.moves.map((m) => m.kind)).toEqual(['travel', 'draw', 'travel', 'draw'])
    expect(tp.moves.map((m) => m.start)).toEqual([0, 0, 10, 15])
    expect(tp.total).toBe(25)
    for (let i = 1; i < tp.moves.length; i++)
      expect(tp.moves[i].start).toBeCloseTo(tp.moves[i - 1].start + tp.moves[i - 1].len)
    expect(tp.moves[1].pen).toBe(0)
    expect(tp.moves[3].pen).toBe(1)
  })

  it('starts with a travel over the fiducial when one is set', () => {
    const tp = buildToolpath(geom, { x: 0, y: 0 }, { x: 3, y: 4 })
    expect(tp.moves[0].kind).toBe('travel')
    expect(tp.moves[0].len).toBeCloseTo(5)
    expect(tp.moves[0].pts.at(-1)).toMatchObject({ x: 3, y: 4 })
    expect(tp.total).toBeCloseTo(5 + 5 + 10 + 5 + 10) // fiducial + back to the first stroke
  })

  it('skips empty strokes and handles empty geometry', () => {
    expect(buildToolpath([])).toEqual({ moves: [], total: 0 })
    expect(buildToolpath([{ points: [], pen: 0, reversible: true }]).moves).toEqual([])
  })
})

describe('sampleAt', () => {
  const tp = buildToolpath(geom)

  it('interpolates linearly along a draw move', () => {
    expect(sampleAt(tp, 5)).toMatchObject({ x: 5, y: 0, penDown: true })
  })

  it('reports pen-up along travels', () => {
    expect(sampleAt(tp, 12.5)).toMatchObject({ x: 10, y: 2.5, penDown: false })
  })

  it('clamps out-of-range distances to the ends', () => {
    expect(sampleAt(tp, -5)).toMatchObject({ x: 0, y: 0 })
    expect(sampleAt(tp, tp.total)).toMatchObject({ x: 10, y: 15 })
    expect(sampleAt(tp, 999)).toMatchObject({ x: 10, y: 15 })
  })

  it('interpolates per-point pressure', () => {
    const ramp = buildToolpath([
      { points: [{ x: 0, y: 0, pressure: 0 }, { x: 10, y: 0, pressure: 1 }], pen: 0, reversible: true },
    ])
    expect(sampleAt(ramp, 5)?.pressure).toBeCloseTo(0.5)
  })

  it('returns null for an empty toolpath', () => {
    expect(sampleAt(buildToolpath([]), 0)).toBeNull()
  })
})
