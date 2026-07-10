import { describe, expect, it } from 'vitest'
import type { GrblProfile, MachineProfile, PrusaProfile } from '../types'
import { penOffsetOf, pressureEnabled } from '../types'
import { AXIDRAW_V3, GRBL_PLOTTER, PRUSA_MK4 } from '../../store/profiles'
import { penParkInPage, plotStartInPage, toMachine } from './toMachine'

function prusa(over: Partial<PrusaProfile> = {}): PrusaProfile {
  return { ...structuredClone(PRUSA_MK4), ...over }
}

describe('toMachine', () => {
  it('is the identity for a top-left origin', () => {
    const p = prusa({ origin: 'top-left' })
    expect(toMachine({ x: 10, y: 20, pressure: 0.5 }, p)).toEqual({ x: 10, y: 20, pressure: 0.5 })
  })

  it('Y-flips for a bottom-left origin, leaving x untouched', () => {
    const p = prusa({ origin: 'bottom-left', bed: { width: 250, height: 210 } })
    expect(toMachine({ x: 10, y: 20 }, p)).toEqual({ x: 10, y: 190, pressure: undefined })
  })

  it('the bottom-left flip is an involution', () => {
    const p = prusa({ origin: 'bottom-left' })
    const q = toMachine(toMachine({ x: 33, y: 44 }, p), p)
    expect(q.x).toBe(33)
    expect(q.y).toBe(44)
  })
})

describe('penParkInPage / plotStartInPage', () => {
  it('park = the pen offset mapped to page space', () => {
    const off = { x: 12, y: 7, z: 0 }
    expect(penParkInPage(prusa({ origin: 'top-left', penOffset: off }))).toEqual({ x: 12, y: 7 })
    const p = prusa({ origin: 'bottom-left', penOffset: off, bed: { width: 250, height: 210 } })
    expect(penParkInPage(p)).toEqual({ x: 12, y: 203 })
  })

  it('an axidraw parks at machine (0,0) — no offset', () => {
    expect(penParkInPage(structuredClone(AXIDRAW_V3))).toEqual({ x: 0, y: 0 })
  })

  it('the plot start is the fiducial when set, the park otherwise', () => {
    const p = prusa({ origin: 'top-left' })
    expect(plotStartInPage(p, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 })
    expect(plotStartInPage(p, null)).toEqual(penParkInPage(p))
    expect(plotStartInPage(p)).toEqual(penParkInPage(p))
  })
})

describe('pressureEnabled / penOffsetOf', () => {
  const grbl = (pen: GrblProfile['pen']): GrblProfile => ({ ...structuredClone(GRBL_PLOTTER), pen })

  it('pressure needs a light pen-down Z on a real Z axis', () => {
    expect(pressureEnabled(prusa({ penZ: { up: 4, down: 0, downLight: 2 } }))).toBe(true)
    expect(pressureEnabled(prusa({ penZ: { up: 4, down: 0 } }))).toBe(false)
    expect(pressureEnabled(grbl({ mode: 'z', up: 5, down: 0, downLight: 2 }))).toBe(true)
    expect(pressureEnabled(grbl({ mode: 'z', up: 5, down: 0 }))).toBe(false)
    expect(pressureEnabled(grbl({ mode: 'servo', upS: 750, downS: 250, raiseMs: 300, lowerMs: 300 }))).toBe(false)
    expect(pressureEnabled(structuredClone(AXIDRAW_V3))).toBe(false)
  })

  it('only a prusa has a pen↔nozzle offset', () => {
    const off = { x: 1, y: 2, z: 3 }
    expect(penOffsetOf(prusa({ penOffset: off }))).toEqual(off)
    const zero = { x: 0, y: 0, z: 0 }
    expect(penOffsetOf(structuredClone(AXIDRAW_V3) as MachineProfile)).toEqual(zero)
    expect(penOffsetOf(structuredClone(GRBL_PLOTTER) as MachineProfile)).toEqual(zero)
  })
})
