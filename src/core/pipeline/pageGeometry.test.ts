// buildPageGeometry's grouping/pen-stamping contract, exercised through the real logo
// registration (multi-pen + locked-by-default): a locked element becomes one chain per pen with
// in-pen drawing order kept; globalOptimize releases its strokes into the bag. Geometry is
// injected via markGenerated (logo is async — the worker normally fills the cache).
import { describe, expect, it } from 'vitest'
import '../../elements/logo'
import { geometryHash, markGenerated } from '../../elements/registry'
import { IDENTITY_TRANSFORM, type DocElement, type Geometry } from '../types'
import { buildPageGeometry } from './index'
import { defaultLogoParams, type LogoParams } from '../../elements/logo'

const pt = (x: number, y: number) => ({ x, y, pressure: 1 })
/** A recognizable one-segment stroke: y encodes the drawing-order index. */
const stroke = (i: number, pen: number): Geometry[number] => ({
  points: [pt(0, i), pt(1, i)],
  pen,
  reversible: true,
  group: 0,
})

function logoElement(id: string, params: LogoParams, geom: Geometry): DocElement {
  markGenerated(id, geometryHash('logo', params), geom)
  return { id, type: 'logo', transform: IDENTITY_TRANSFORM, params, pen: 0 }
}

describe('buildPageGeometry — locked multi-pen element', () => {
  // The turtle alternated pens: 0, 1, 0, 1, 0.
  const drawn = [stroke(0, 0), stroke(1, 1), stroke(2, 0), stroke(3, 1), stroke(4, 0)]

  it('locks into one chain per pen, keeping in-pen drawing order', () => {
    const el = logoElement('lk', defaultLogoParams(), drawn)
    const out = buildPageGeometry([el])

    expect(out).toHaveLength(5)
    // One contiguous chain per pen, distinct nonzero ids, direction locked.
    expect(out.map((s) => s.pen)).toEqual([0, 0, 0, 1, 1])
    expect(out.map((s) => s.group)).toEqual([1, 1, 1, 2, 2])
    expect(out.every((s) => !s.reversible)).toBe(true)
    // Drawing order survives within each pen (y encodes the original index).
    expect(out.map((s) => s.points[0].y)).toEqual([0, 2, 4, 1, 3])
  })

  it('globalOptimize releases the strokes as free singletons', () => {
    const el = logoElement('fr', { ...defaultLogoParams(), globalOptimize: true }, drawn)
    const out = buildPageGeometry([el])

    expect(out).toHaveLength(5)
    expect(out.every((s) => !s.group)).toBe(true)
    expect(out.every((s) => s.reversible)).toBe(true)
    // Per-stroke pens kept (multiPen: no stamping of the element's single pen).
    expect(out.map((s) => s.pen)).toEqual([0, 1, 0, 1, 0])
  })

  it('chain ids stay distinct across locked elements', () => {
    const a = logoElement('a', defaultLogoParams(), [stroke(0, 0)])
    const b = logoElement('b', defaultLogoParams(), [stroke(1, 0)])
    const out = buildPageGeometry([a, b])
    expect(out.map((s) => s.group)).toEqual([1, 2])
  })
})
