import { describe, expect, it } from 'vitest'
import type { AxidrawProfile, GrblProfile, PrusaProfile } from './types'
import { AXIDRAW_V3, GRBL_PLOTTER, PROFILE_PRESETS, PRUSA_MK4 } from '../store/profiles'
import { validateProfile } from './profileValidation'

describe('validateProfile', () => {
  // Presets and validation rules cross-check each other: a new preset must be valid, and a new
  // rule must not reject any shipped preset.
  it.each(PROFILE_PRESETS.map((p) => [p.name, p] as const))('preset %s is valid', (_name, p) => {
    expect(validateProfile(p)).toEqual([])
  })

  const prusa = (over: Partial<PrusaProfile>): PrusaProfile => ({ ...structuredClone(PRUSA_MK4), ...over })
  const grbl = (over: Partial<GrblProfile>): GrblProfile => ({ ...structuredClone(GRBL_PLOTTER), ...over })
  const axidraw = (over: Partial<AxidrawProfile>): AxidrawProfile => ({ ...structuredClone(AXIDRAW_V3), ...over })

  it('rejects a zero-size bed', () => {
    expect(validateProfile(prusa({ bed: { width: 0, height: 210 } })).length).toBeGreaterThan(0)
  })

  it('rejects pen heights that do not step down', () => {
    expect(validateProfile(prusa({ penZ: { up: 0, down: 4 } })).length).toBeGreaterThan(0)
    expect(validateProfile(prusa({ penZ: { up: 4, down: 0, downLight: 5 } })).length).toBeGreaterThan(0)
    expect(validateProfile(grbl({ pen: { mode: 'z', up: 0, down: 5 } })).length).toBeGreaterThan(0)
  })

  it('rejects a servo that never lifts or leaves its range', () => {
    expect(
      validateProfile(grbl({ pen: { mode: 'servo', upS: 500, downS: 500, raiseMs: 0, lowerMs: 0 } })).length,
    ).toBeGreaterThan(0)
    expect(
      validateProfile(grbl({ pen: { mode: 'servo', upS: 1500, downS: 250, raiseMs: 0, lowerMs: 0 } })).length,
    ).toBeGreaterThan(0)
    expect(
      validateProfile(axidraw({ servo: { upPercent: 40, downPercent: 40, liftMs: 0, dropMs: 0 } })).length,
    ).toBeGreaterThan(0)
  })

  it('rejects non-positive motion limits and feeds', () => {
    expect(validateProfile(prusa({ feeds: { travel: 0, draw: 3000 } })).length).toBeGreaterThan(0)
    expect(validateProfile(grbl({ baudRate: 0 })).length).toBeGreaterThan(0)
    expect(
      validateProfile(axidraw({ motion: { drawSpeed: 25, travelSpeed: 100, acceleration: 0, cornering: 0.1 } })).length,
    ).toBeGreaterThan(0)
  })
})
