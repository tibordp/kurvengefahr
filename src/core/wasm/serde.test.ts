import { describe, expect, it } from 'vitest'
import type { Geometry } from '../types'
import { flatten, unflatten } from './serde'

// Float32-exact coordinates so round-trip equality is exact, not approximate.
const geom: Geometry = [
  {
    points: [
      { x: 1.5, y: -3.25, pressure: 0.5 },
      { x: 10, y: 20.75, pressure: 0.25 },
    ],
    pen: 2,
    reversible: true,
    group: 7,
  },
  {
    points: [{ x: 0, y: 0, pressure: 1 }],
    pen: 0,
    reversible: false,
    group: 7,
  },
]

describe('flatten/unflatten', () => {
  it('round-trips geometry with explicit pressure and a nonzero group', () => {
    expect(unflatten(flatten(geom))).toEqual(geom)
  })

  it('normalizes one way: missing pressure → 1, group 0/absent → key omitted, reversible → boolean', () => {
    const out = unflatten(
      flatten([
        { points: [{ x: 1, y: 2 }], pen: 0, reversible: true, group: 0 },
        { points: [{ x: 3, y: 4 }], pen: 1, reversible: false },
      ]),
    )
    expect(out[0].points[0].pressure).toBe(1)
    expect('group' in out[0]).toBe(false)
    expect('group' in out[1]).toBe(false)
    expect(out[0].reversible).toBe(true)
    expect(out[1].reversible).toBe(false)
  })

  it('is a fixpoint: flatten(unflatten(flat)) reproduces flat typed-array-exactly', () => {
    const flat = flatten(geom)
    expect(flatten(unflatten(flat))).toEqual(flat)
  })

  it('builds a well-formed CSR layout', () => {
    const flat = flatten(geom)
    expect(flat.offsets.length).toBe(geom.length + 1)
    expect(flat.offsets[0]).toBe(0)
    expect(flat.offsets[geom.length]).toBe(3) // total points
    expect(flat.xy.length).toBe(6)
    expect(flat.pressure.length).toBe(3)
    expect(flat.pen.length).toBe(2)
    expect(flat.reversible.length).toBe(2)
    expect(flat.group.length).toBe(2)
  })

  it('handles empty geometry', () => {
    const flat = flatten([])
    expect(flat.offsets).toEqual(new Uint32Array([0]))
    expect(flat.xy.length).toBe(0)
    expect(unflatten(flat)).toEqual([])
  })

  it('keeps an empty-points stroke as a zero-width CSR row', () => {
    const out = unflatten(flatten([{ points: [], pen: 3, reversible: true }]))
    expect(out).toEqual([{ points: [], pen: 3, reversible: true }])
  })
})
