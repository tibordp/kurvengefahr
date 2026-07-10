// The cheap-invalidation contract: geometry regenerates only when geometry-affecting params
// actually change. Uses synthetic element types so the test is immune to real-element churn; the
// cache is module-global and keyed by element id, so each test uses fresh ids.
import { describe, expect, it } from 'vitest'
import { IDENTITY_TRANSFORM, type DocElement, type Geometry } from '../core/types'
import {
  dropFromCache,
  generateLocal,
  geometryHash,
  getCached,
  hashParams,
  isAsyncType,
  markGenerated,
  registerElement,
} from './registry'

let generated = 0
registerElement('__sync__', {
  generate: (params: any): Geometry => {
    generated++
    return [{ points: [{ x: 0, y: 0 }, { x: params.size, y: 0 }], pen: 0, reversible: true }]
  },
  viewParams: ['view'],
})
registerElement('__async__', {}) // no generator — worker-backed

const el = (id: string, params: unknown, type = '__sync__'): DocElement => ({
  id,
  type,
  transform: IDENTITY_TRANSFORM,
  params,
  pen: 0,
})

describe('hashParams', () => {
  it('is independent of object key order, recursively', () => {
    expect(hashParams({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(hashParams({ b: { d: [1, 2], c: 2 }, a: 1 }))
  })

  it('keeps array order significant', () => {
    expect(hashParams([1, 2])).not.toBe(hashParams([2, 1]))
  })

  it('distinguishes primitives and null', () => {
    expect(hashParams(null)).not.toBe(hashParams(0))
    expect(hashParams('1')).not.toBe(hashParams(1))
  })
})

describe('geometryHash', () => {
  it('strips registered viewParams so display toggles never change the hash', () => {
    expect(geometryHash('__sync__', { size: 5, view: true })).toBe(geometryHash('__sync__', { size: 5, view: false }))
    expect(geometryHash('__sync__', { size: 5, view: true })).toBe(geometryHash('__sync__', { size: 5 }))
    expect(geometryHash('__sync__', { size: 5 })).not.toBe(geometryHash('__sync__', { size: 6 }))
  })
})

describe('generateLocal memoization', () => {
  it('regenerates only when geometry-affecting params change', () => {
    const params = { size: 2, view: false }
    const e = el('memo-1', params)
    const before = generated

    const geom = generateLocal(e)
    expect(generated).toBe(before + 1)

    // Same params reference → fast path, no rehash/regen.
    expect(generateLocal(e)).toBe(geom)
    expect(generated).toBe(before + 1)

    // New object, equal geometry content → hash match, no regen — and the fast path re-arms.
    const bumped = el('memo-1', { size: 2, view: true })
    expect(generateLocal(bumped)).toBe(geom)
    expect(generateLocal(bumped)).toBe(geom)
    expect(generated).toBe(before + 1)

    // A geometry param change regenerates.
    generateLocal(el('memo-1', { size: 3 }))
    expect(generated).toBe(before + 2)
  })

  it('async types return empty, then cached, then stale geometry — never compute', () => {
    expect(isAsyncType('__async__')).toBe(true)
    const params = { text: 'hello' }
    const e = el('async-1', params, '__async__')
    expect(generateLocal(e)).toEqual([])

    const ink: Geometry = [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], pen: 0, reversible: true }]
    markGenerated('async-1', geometryHash('__async__', params), ink)
    expect(generateLocal(e)).toBe(ink)
    expect(getCached('async-1')?.hash).toBe(geometryHash('__async__', params))

    // Params changed but the worker hasn't delivered yet → last known ink, not [].
    expect(generateLocal(el('async-1', { text: 'changed' }, '__async__'))).toBe(ink)

    dropFromCache('async-1')
    expect(generateLocal(e)).toEqual([])
  })
})
