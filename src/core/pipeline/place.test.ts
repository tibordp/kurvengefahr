import { describe, expect, it } from 'vitest'
import type { DocElement, Geometry, Transform } from '../types'
import { IDENTITY_TRANSFORM } from '../types'
import {
  applyMatrix,
  composeTransforms,
  effectiveTransform,
  invertTransform,
  localToPage,
  matrixToTransform,
  multiplyMatrix,
  pageToLocal,
  place,
  transformToMatrix,
} from './place'

const t = (over: Partial<Transform> = {}): Transform => ({ ...IDENTITY_TRANSFORM, ...over })

const expectTransformClose = (got: Transform, want: Transform) => {
  expect(got.x).toBeCloseTo(want.x, 9)
  expect(got.y).toBeCloseTo(want.y, 9)
  expect(got.rotation).toBeCloseTo(want.rotation, 9)
  expect(got.scaleX).toBeCloseTo(want.scaleX, 9)
  expect(got.scaleY).toBeCloseTo(want.scaleY, 9)
}

const SAMPLE_POINTS = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: -3, y: 7.5 },
]

describe('transformToMatrix / matrixToTransform', () => {
  const cases: [string, Transform][] = [
    ['identity', t()],
    ['translate', t({ x: 5, y: -3 })],
    ['rotate', t({ rotation: 30 })],
    ['non-uniform scale', t({ scaleX: 2, scaleY: 3 })],
    ['negative scaleY', t({ scaleY: -2 })],
    ['combined', t({ x: 12, y: 4, rotation: -45, scaleX: 1.5, scaleY: 0.5 })],
  ]
  it.each(cases)('round-trips %s', (_name, tr) => {
    expectTransformClose(matrixToTransform(transformToMatrix(tr)), tr)
  })

  // Negative scaleX decomposes to an equivalent (rotation+180, flipped-scaleY) form — the
  // components differ but the mapping must not.
  it('preserves the point mapping for negative scaleX', () => {
    const tr = t({ x: 3, y: 1, rotation: 20, scaleX: -2, scaleY: 1.5 })
    const back = matrixToTransform(transformToMatrix(tr))
    for (const p of SAMPLE_POINTS) {
      const a = localToPage(tr, p.x, p.y)
      const b = localToPage(back, p.x, p.y)
      expect(b.x).toBeCloseTo(a.x, 9)
      expect(b.y).toBeCloseTo(a.y, 9)
    }
  })
})

describe('multiplyMatrix / composeTransforms', () => {
  it('applies b first, then a', () => {
    const a = transformToMatrix(t({ rotation: 90 }))
    const b = transformToMatrix(t({ x: 10 }))
    const p = { x: 1, y: 2 }
    const viaProduct = applyMatrix(multiplyMatrix(a, b), p)
    const viaSteps = applyMatrix(a, applyMatrix(b, p))
    expect(viaProduct.x).toBeCloseTo(viaSteps.x, 9)
    expect(viaProduct.y).toBeCloseTo(viaSteps.y, 9)
  })

  it('composeTransforms(parent, child) maps points child-first', () => {
    const parent = t({ x: 10, rotation: 90 })
    const child = t({ x: 0, y: 5, scaleX: 2, scaleY: 2 })
    const composed = composeTransforms(parent, child)
    for (const p of SAMPLE_POINTS) {
      const inParent = localToPage(child, p.x, p.y)
      const step = localToPage(parent, inParent.x, inParent.y)
      const direct = localToPage(composed, p.x, p.y)
      expect(direct.x).toBeCloseTo(step.x, 9)
      expect(direct.y).toBeCloseTo(step.y, 9)
    }
  })
})

describe('invertTransform / pageToLocal', () => {
  // Decomposed transforms can't carry shear, so the inverse is exact for uniform scale (any
  // rotation) and for non-uniform scale without rotation — the shapes the editor produces.
  const cases: [string, Transform][] = [
    ['translate + rotate + uniform scale', t({ x: 7, y: -2, rotation: 33, scaleX: 2, scaleY: 2 })],
    ['non-uniform scale, no rotation', t({ x: -4, y: 9, scaleX: 0.5, scaleY: 3 })],
  ]
  it.each(cases)('compose(invert(t), t) is the identity mapping for %s', (_name, tr) => {
    const roundTrip = composeTransforms(invertTransform(tr), tr)
    for (const p of SAMPLE_POINTS) {
      const q = localToPage(roundTrip, p.x, p.y)
      expect(q.x).toBeCloseTo(p.x, 6)
      expect(q.y).toBeCloseTo(p.y, 6)
    }
  })

  it.each(cases)('pageToLocal inverts localToPage for %s', (_name, tr) => {
    for (const p of SAMPLE_POINTS) {
      const page = localToPage(tr, p.x, p.y)
      const back = pageToLocal(tr, page.x, page.y)
      expect(back.x).toBeCloseTo(p.x, 6)
      expect(back.y).toBeCloseTo(p.y, 6)
    }
  })
})

describe('effectiveTransform', () => {
  const el = (id: string, transform: Transform, parent?: string): DocElement => ({
    id,
    type: 'path',
    transform,
    params: {},
    pen: 0,
    ...(parent ? { parent } : {}),
  })

  it('composes up the parent chain', () => {
    const gp = el('gp', t({ x: 10 }))
    const parent = el('p', t({ y: 5 }), 'gp')
    const child = el('c', t({ x: 1, y: 1 }), 'p')
    const byId = new Map([gp, parent, child].map((e) => [e.id, e]))
    expectTransformClose(effectiveTransform(child, byId), t({ x: 11, y: 6 }))
  })

  it('falls back to the own transform when the parent id is unknown', () => {
    const orphan = el('o', t({ x: 3 }), 'missing')
    expect(effectiveTransform(orphan, new Map())).toEqual(t({ x: 3 }))
  })
})

describe('place', () => {
  const geom: Geometry = [
    {
      points: [
        { x: 1, y: 2, pressure: 0.5 },
        { x: 3, y: 4 },
      ],
      pen: 3,
      reversible: false,
      group: 9,
      feed: 1200,
    },
  ]

  it('transforms points and passes stroke metadata through untouched', () => {
    const [s] = place(geom, t({ x: 10, y: 20 }))
    expect(s.points[0].x).toBeCloseTo(11)
    expect(s.points[0].y).toBeCloseTo(22)
    expect(s.pen).toBe(3)
    expect(s.reversible).toBe(false)
    expect(s.group).toBe(9)
    expect(s.feed).toBe(1200)
  })

  it('applies element pressure as a gain, never an overwrite', () => {
    const [s] = place(geom, t(), 0.5)
    expect(s.points[0].pressure).toBeCloseTo(0.25) // 0.5 × gain 0.5
    expect(s.points[1].pressure).toBeCloseTo(0.5) // missing → treated as 1 × gain
  })

  it('leaves per-point pressure untouched when the gain is omitted', () => {
    const [s] = place(geom, t())
    expect(s.points[0].pressure).toBe(0.5)
    expect(s.points[1].pressure).toBeUndefined()
  })
})
