import { describe, expect, it } from 'vitest'
import type { PrusaProfile } from '../types'
import { PRUSA_MK4 } from '../../store/profiles'
import { drawableRegion } from './clip'

// drawableRegion only — the actual polyline clipping lives in the crate.
function profile(over: Partial<PrusaProfile> = {}): PrusaProfile {
  return {
    ...structuredClone(PRUSA_MK4),
    origin: 'top-left',
    bed: { width: 200, height: 100 },
    penOffset: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

describe('drawableRegion', () => {
  it('is the full bed with a zero pen offset', () => {
    expect(drawableRegion(profile())).toEqual({ x0: 0, y0: 0, x1: 200, y1: 100 })
  })

  it('a positive offset cuts the strip near machine zero, a negative one near the far edge', () => {
    expect(drawableRegion(profile({ penOffset: { x: 12, y: 0, z: 0 } }))).toEqual({ x0: 12, y0: 0, x1: 200, y1: 100 })
    expect(drawableRegion(profile({ penOffset: { x: -12, y: 5, z: 0 } }))).toEqual({ x0: 0, y0: 5, x1: 188, y1: 100 })
  })

  it('a bottom-left origin lands the unreachable strip on the opposite page edge', () => {
    // Pen 5 mm above the nozzle in machine coords: machine reach is y ∈ [5, 100], which is the
    // TOP of the page for a bottom-left machine — page y ∈ [0, 95].
    const r = drawableRegion(profile({ origin: 'bottom-left', penOffset: { x: 0, y: 5, z: 0 } }))
    expect(r).toEqual({ x0: 0, y0: 0, x1: 200, y1: 95 })
  })

  it('stays within the bed and shrinks by exactly the offset magnitude', () => {
    for (const off of [
      { x: 7, y: -3, z: 0 },
      { x: -20, y: 15, z: 2 },
    ]) {
      for (const origin of ['top-left', 'bottom-left'] as const) {
        const p = profile({ origin, penOffset: off })
        const r = drawableRegion(p)
        expect(r.x0).toBeGreaterThanOrEqual(0)
        expect(r.y0).toBeGreaterThanOrEqual(0)
        expect(r.x1).toBeLessThanOrEqual(p.bed.width)
        expect(r.y1).toBeLessThanOrEqual(p.bed.height)
        expect(r.x1 - r.x0).toBeCloseTo(p.bed.width - Math.abs(off.x))
        expect(r.y1 - r.y0).toBeCloseTo(p.bed.height - Math.abs(off.y))
      }
    }
  })
})
