import { describe, expect, it } from 'vitest'
import type { Geometry, GrblProfile } from '../types'
import { GRBL_PLOTTER } from '../../store/profiles'
import { MAX_SEG_MM, planGrblTape } from './grblTape'
import { emitGrbl, grblInitLines, grblSegmentLines, newEmitCtx } from './emitGrbl'
import { SEG } from './planTypes'

/** A test profile: top-left origin (machine == page coords) unless overridden. */
function profile(over: Partial<GrblProfile> = {}): GrblProfile {
  return { ...structuredClone(GRBL_PLOTTER), origin: 'top-left', ...over }
}

const stroke = (pts: [number, number, number?][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y, pressure]) => ({ x, y, ...(pressure !== undefined ? { pressure } : {}) })),
  pen,
  reversible: true,
})

const kinds = (tape: ReturnType<typeof planGrblTape>) => Array.from(tape.kind)

describe('planGrblTape', () => {
  it('walks: pen-up, per-stroke travel/down/draw/up, home — with pauses on pen change', () => {
    const tape = planGrblTape([stroke([[10, 0], [20, 0]], 0), stroke([[20, 10], [30, 10]], 1)], profile())
    expect(kinds(tape)).toEqual([
      SEG.penUp,
      SEG.motion, // travel to stroke 1
      SEG.penDown,
      SEG.motion, // draw
      SEG.penUp,
      SEG.pausePenswap,
      SEG.motion, // travel to stroke 2
      SEG.penDown,
      SEG.motion, // draw
      SEG.penUp,
      SEG.motion, // walk home
    ])
    // The swap pause happens pen-up, and carries the NEW pen for the prompt/message.
    expect(tape.pen[5]).toBe(1)
    // blockStart marks the first travel of each stroke only.
    expect(Array.from(tape.blockStart)).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0])
    // dist counts travel + draw but not the walk home:
    // travel (0,0)→(10,0) = 10, draw = 10, travel (20,0)→(20,10) = 10, draw = 10.
    expect(tape.totalDist).toBeCloseTo(40)
    expect(tape.dist[tape.length - 1]).toBeCloseTo(40) // home segment doesn't advance
    // Walk home ends at work zero.
    expect(tape.x[tape.length - 1]).toBe(0)
    expect(tape.y[tape.length - 1]).toBe(0)
  })

  it('starts with the fiducial travel + pause when one is set', () => {
    const tape = planGrblTape([stroke([[10, 10], [20, 10]])], profile(), { x: 5, y: 5 })
    expect(kinds(tape).slice(0, 3)).toEqual([SEG.penUp, SEG.motion, SEG.pauseFiducial])
    expect(tape.x[1]).toBeCloseTo(5)
    // Fiducial travel counts toward dist (it's in the preview toolpath).
    expect(tape.dist[1]).toBeCloseTo(Math.hypot(5, 5))
  })

  it('Y-flips for a bottom-left origin', () => {
    const p = profile({ origin: 'bottom-left', bed: { width: 100, height: 100 } })
    const tape = planGrblTape([stroke([[10, 10], [20, 10]])], p)
    const draw = kinds(tape).indexOf(SEG.motion, kinds(tape).indexOf(SEG.penDown))
    expect(tape.y[draw]).toBeCloseTo(90) // page y=10 → machine y=100−10
  })

  it('splits long moves so buffered motion stays short', () => {
    const tape = planGrblTape([stroke([[0, 0], [120, 0]])], profile())
    const draws = kinds(tape)
      .map((k, i) => (k === SEG.motion && tape.penDown[i] ? i : -1))
      .filter((i) => i >= 0)
    expect(draws.length).toBe(Math.ceil(120 / MAX_SEG_MM))
    expect(tape.x[draws[0]]).toBeCloseTo(40)
    expect(tape.dist[draws.at(-1)!]).toBeCloseTo(120)
  })

  it('empty geometry yields an empty tape', () => {
    const tape = planGrblTape([], profile())
    expect(tape.length).toBe(0)
    expect(tape.totalDist).toBe(0)
  })
})

describe('emitGrbl', () => {
  it('renders a servo-mode job: init, M3/G4 pen moves, G0 travels, modal-F G1 draws, M5', () => {
    const gcode = emitGrbl(planGrblTape([stroke([[10, 0], [20, 0], [30, 0]])], profile()), profile())
    const lines = gcode.trim().split('\n')
    expect(lines.slice(0, 4)).toEqual(['G21', 'G90', 'G54', 'G10 L20 P1 X0 Y0 Z0'])
    // No $H (homing off); initial pen-up is a servo raise + settle.
    expect(lines).not.toContain('$H')
    expect(lines.slice(4, 6)).toEqual(['M3 S750', 'G4 P0.300'])
    expect(lines).toContain('G0 X10.000 Y0.000')
    expect(lines).toContain('M3 S250') // pen down
    // First draw carries F, the second (same feed) doesn't — modal.
    expect(lines).toContain('G1 X20.000 Y0.000 F1500.000')
    expect(lines).toContain('G1 X30.000 Y0.000')
    expect(lines.at(-1)).toBe('M5')
  })

  it('renders $H (and still sets work zero) when homing is on', () => {
    const p = profile({ homing: true })
    const lines = emitGrbl(planGrblTape([stroke([[10, 0], [20, 0]])], p), p).split('\n')
    expect(lines[0]).toBe('$H')
    expect(lines).toContain('G10 L20 P1 X0 Y0 Z0')
  })

  it('renders a Z-mode job with a pressure ramp', () => {
    const p = profile({ pen: { mode: 'z', up: 5, down: 0, downLight: 2 } })
    const tape = planGrblTape([stroke([[0, 0, 0], [10, 0, 1]])], p)
    const ctx = newEmitCtx()
    const all: string[] = [...grblInitLines(p)]
    for (let i = 0; i < tape.length; i++) all.push(...grblSegmentLines(tape, i, p, ctx))
    expect(all).toContain('G0 Z5.000') // pen up
    expect(all).toContain('G1 Z2.000 F4000.000') // pen down at pressure 0 → downLight
    expect(all).toContain('G1 X10.000 Y0.000 Z0.000 F1500.000') // ramp to full pressure
    expect(all).not.toContain('M5')
  })

  it('substitutes the pause macro at fiducial and pen-swap pauses', () => {
    const geom = [stroke([[10, 0], [20, 0]], 0), stroke([[20, 10], [30, 10]], 1)]
    const p = profile({
      pens: [
        { id: 0, name: 'Black', color: '#000' },
        { id: 1, name: 'Red', color: '#f00' },
      ],
    })
    const gcode = emitGrbl(planGrblTape(geom, p, { x: 1, y: 1 }), p)
    expect(gcode).toContain('M0 ; Align medium to fiducial')
    expect(gcode).toContain('M0 ; Change to Red')
  })

  it('honours user preamble/postamble around the generated job', () => {
    const p = profile({ preamble: '; hello', postamble: '; bye' })
    const lines = emitGrbl(planGrblTape([stroke([[10, 0], [20, 0]])], p), p).trim().split('\n')
    expect(lines[0]).toBe('; hello')
    expect(lines.at(-1)).toBe('; bye')
  })
})
