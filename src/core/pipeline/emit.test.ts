import { describe, expect, it } from 'vitest'
import type { Geometry, PrusaProfile } from '../types'
import { PRUSA_MK4 } from '../../store/profiles'
import { emit, pauseLines } from './emit'

/** A test profile: top-left origin (machine == page), zero offset, one-line pre/postamble. */
function profile(over: Partial<PrusaProfile> = {}): PrusaProfile {
  return {
    ...structuredClone(PRUSA_MK4),
    origin: 'top-left',
    penOffset: { x: 0, y: 0, z: 0 },
    preamble: '; pre',
    postamble: '; post',
    ...over,
  }
}

const stroke = (pts: [number, number, number?][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y, pressure]) => ({ x, y, ...(pressure !== undefined ? { pressure } : {}) })),
  pen,
  reversible: true,
})

const emitLines = (geom: Geometry, p: PrusaProfile, fiducial?: { x: number; y: number }) =>
  emit(geom, p, fiducial).trim().split('\n')

describe('emit', () => {
  it('renders the job shape: preamble, pen-up, travel/down/draw/up per stroke, postamble', () => {
    const p = profile()
    const gcode = emit([stroke([[10, 5], [20, 5]])], p)
    expect(gcode.endsWith('\n')).toBe(true)
    expect(gcode.trim().split('\n')).toEqual([
      '; pre',
      'G0 Z4.000', // initial pen-up: penZ.up
      'G0 X10.000 Y5.000 F9000.000', // travel to the stroke start
      'G1 Z0.000 F9000.000', // pen down at full pressure → penZ.down
      'G1 X20.000 Y5.000 F3000.000', // draw at the draw feed
      'G0 Z4.000', // pen up
      '; post',
    ])
  })

  it('subtracts the pen offset from X, Y and Z', () => {
    const p = profile({ penOffset: { x: 12, y: -7, z: 1.5 } })
    const lines = emitLines([stroke([[20, 10], [30, 10]])], p)
    expect(lines).toContain('G0 Z2.500') // up 4 − off.z 1.5
    expect(lines).toContain('G0 X8.000 Y17.000 F9000.000') // 20−12, 10−(−7)
    expect(lines).toContain('G1 Z-1.500 F9000.000') // down 0 − off.z
  })

  it('Y-flips for a bottom-left origin', () => {
    const p = profile({ origin: 'bottom-left', bed: { width: 250, height: 210 } })
    expect(emitLines([stroke([[10, 10], [20, 10]])], p)).toContain('G0 X10.000 Y200.000 F9000.000')
  })

  it('plots pens in palette order with a pause between groups, regardless of input order', () => {
    const p = profile({
      pens: [
        { id: 0, name: 'Black', color: '#000' },
        { id: 1, name: 'Red', color: '#f00' },
      ],
    })
    const lines = emitLines([stroke([[10, 0], [20, 0]], 1), stroke([[30, 0], [40, 0]], 0)], p)
    // Pen 0 (Black) plots first even though the pen-1 stroke came first.
    expect(lines.indexOf('G0 X30.000 Y0.000 F9000.000')).toBeLessThan(lines.indexOf('G0 X10.000 Y0.000 F9000.000'))
    // The swap: clearance lift, pause macro with the pen name, working pen-up re-asserted.
    const lift = lines.indexOf('G0 Z30.000 ; lift for pen change')
    expect(lines.slice(lift, lift + 4)).toEqual([
      'G0 Z30.000 ; lift for pen change',
      'G4 P500',
      'M0 Change to Red',
      'G0 Z4.000',
    ])
  })

  it('emits no pause in a single-pen job', () => {
    expect(emit([stroke([[10, 0], [20, 0]])], profile())).not.toContain('Change to')
  })

  it('plots a stray pen missing from the palette last', () => {
    const lines = emitLines([stroke([[10, 0], [20, 0]], 5), stroke([[30, 0], [40, 0]], 0)], profile())
    expect(lines.indexOf('G0 X30.000 Y0.000 F9000.000')).toBeLessThan(lines.indexOf('G0 X10.000 Y0.000 F9000.000'))
    expect(lines).toContain('M0 Change to pen 5')
  })

  it('aligns to the fiducial (offset-adjusted) before any pen work', () => {
    const p = profile({ penOffset: { x: 2, y: 0, z: 0 } })
    const lines = emitLines([stroke([[10, 0], [20, 0]])], p, { x: 5, y: 6 })
    const clearance = lines.indexOf('G0 Z30.000 ; fiducial: clearance')
    expect(clearance).toBeGreaterThan(-1)
    expect(lines[clearance + 1]).toBe('G0 X3.000 Y6.000 F9000.000 ; fiducial: align point')
    expect(lines[clearance + 3]).toBe('M0 Align medium to fiducial')
    expect(clearance).toBeLessThan(lines.indexOf('G0 Z4.000'))
  })

  it('emits no fiducial moves when there is nothing to plot', () => {
    expect(emit([], profile(), { x: 5, y: 6 })).not.toContain('fiducial')
  })

  it('ramps Z along a variable-pressure stroke', () => {
    // penZ {up: 4, down: 0, downLight: 2}: pressure 0 → 2, pressure 1 → 0.
    const lines = emitLines([stroke([[0, 0, 0], [10, 0, 1]])], profile())
    expect(lines).toContain('G1 Z2.000 F9000.000') // pen down at the light Z
    expect(lines).toContain('G1 X10.000 Y0.000 Z0.000 F3000.000') // draw ramps to full
  })

  it('emits no Z words in constant-pressure draw moves', () => {
    const lines = emitLines([stroke([[0, 0], [10, 0], [20, 0]])], profile())
    for (const l of lines.filter((l) => l.startsWith('G1 X'))) expect(l).not.toContain('Z')
  })

  it('ignores pressure entirely when the profile has no light pen-down Z', () => {
    const p = profile({ penZ: { up: 4, down: 1 } })
    const lines = emitLines([stroke([[0, 0, 0], [10, 0, 1]])], p)
    expect(lines).toContain('G1 Z1.000 F9000.000')
    for (const l of lines.filter((l) => l.startsWith('G1 X'))) expect(l).not.toContain('Z')
  })

  it('skips empty strokes and renders bare preamble/postamble for an empty job', () => {
    const p = profile()
    expect(emit([], p)).toBe('; pre\n; post\n')
    expect(emit([{ points: [], pen: 0, reversible: true }], p)).toBe('; pre\n; post\n')
  })
})

describe('pauseLines', () => {
  it('substitutes {message} and splits multi-line templates', () => {
    expect(pauseLines('G4 P500\nM0 {message}', 'Change to Red')).toEqual(['G4 P500', 'M0 Change to Red'])
  })

  it('returns no lines for an empty or blank template', () => {
    expect(pauseLines('', 'msg')).toEqual([])
    expect(pauseLines('  \n ', 'msg')).toEqual([])
  })
})
