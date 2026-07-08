import { describe, expect, it } from 'vitest'
import { justifyOffsets, lineShift } from './layoutMath'

describe('lineShift', () => {
  it('aligns within the wrap box', () => {
    expect(lineShift('left', 100, 60)).toBe(0)
    expect(lineShift('center', 100, 60)).toBe(20)
    expect(lineShift('right', 100, 60)).toBe(40)
    // Justify lines are assembled at x=0 and stretched per word instead.
    expect(lineShift('justify', 100, 60)).toBe(0)
  })
})

describe('justifyOffsets', () => {
  it('spreads the slack evenly across gaps on soft lines', () => {
    const shifts = justifyOffsets(4, 100, 70, true)
    expect(shifts).toEqual([0, 10, 20, 30]) // 30 mm slack over 3 gaps
  })

  it('leaves hard-broken lines ragged', () => {
    expect(justifyOffsets(4, 100, 70, false)).toEqual([0, 0, 0, 0])
  })

  it('has nothing to stretch on single-word lines', () => {
    expect(justifyOffsets(1, 100, 70, true)).toEqual([0])
    expect(justifyOffsets(0, 100, 70, true)).toEqual([])
  })

  it('never shrinks an overflowing line', () => {
    expect(justifyOffsets(3, 100, 120, true)).toEqual([0, 0, 0])
  })
})
