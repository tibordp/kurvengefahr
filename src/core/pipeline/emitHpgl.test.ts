import { describe, expect, it } from 'vitest'
import type { Geometry, HpglProfile } from '../types'
import { HPGL_CUTTER } from '../../store/profiles'
import { planGrblTape } from './grblTape'
import { emitHpgl } from './emitHpgl'

function profile(over: Partial<HpglProfile> = {}): HpglProfile {
  return {
    ...structuredClone(HPGL_CUTTER),
    bed: { width: 100, height: 100 },
    pens: [
      { id: 0, name: 'Black', color: '#000' },
      { id: 7, name: 'Red', color: '#f00' },
    ],
    ...over,
  }
}

const stroke = (pts: [number, number][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y]) => ({ x, y })),
  pen,
  reversible: true,
})

describe('emitHpgl', () => {
  it('emits plotter units (40/mm), y-up from a bottom-left origin, and walks home', () => {
    const p = profile()
    const out = emitHpgl(planGrblTape([stroke([[10, 90], [20, 90.0125]])], p, null, Infinity), p)
    expect(out.split('\n').filter(Boolean)).toEqual([
      'IN;',
      'SP1;',
      'PU;',
      'PU400,400;',
      'PD;',
      'PD800,400;', // 9.9875 mm → 399.5 rounds to 400
      'PU;',
      'PU0,0;',
    ])
  })

  it('keeps a long travel as one move when unsplit', () => {
    const p = profile({ bed: { width: 1000, height: 1000 } })
    const out = emitHpgl(planGrblTape([stroke([[500, 500], [501, 500]])], p, null, Infinity), p)
    expect(out.split('\n').filter((c) => c.startsWith('PU') && c !== 'PU;')).toEqual(['PU20000,20000;', 'PU0,0;'])
  })

  it('emits VS/FS only when set, and SP by pen slot at a pen change', () => {
    const p = profile({ origin: 'top-left', speed: 20, force: 80 })
    const out = emitHpgl(planGrblTape([stroke([[0, 0], [1, 0]], 0), stroke([[2, 0], [3, 0]], 7)], p), p)
    const cmds = out.split('\n')
    expect(cmds.slice(0, 4)).toEqual(['IN;', 'SP1;', 'VS20;', 'FS80;'])
    expect(cmds).toContain('SP2;')
  })
})
