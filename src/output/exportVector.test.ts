// SVG export layering with the REAL WASM module: element → part → pen nesting, document order, and
// the stroke `part` tag surviving the clip stage. Requires crate/pkg (`npm run build:wasm` if stale).
import { beforeAll, describe, expect, it } from 'vitest'
import '../elements/shapes'
import { initWasmForTests } from '../core/wasm/nodeTestInit'
import { registerElement } from '../elements/registry'
import { defaultRectParams } from '../elements/shapes'
import { IDENTITY_TRANSFORM, type DocElement, type Geometry } from '../core/types'
import { PRUSA_MK4 } from '../store/profiles'
import { useDoc } from '../store/document'
import { buildSvgMarkup } from './exportVector'

// A stand-in for a part-tagging generator (tonal hatching tags its bands the same way in Rust).
registerElement('banded', {
  label: 'Banded',
  generate: (): Geometry => [
    { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], pen: 0, reversible: true, part: 2 },
    { points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], pen: 0, reversible: true, part: 1 },
    { points: [{ x: 0, y: 8 }, { x: 10, y: 8 }], pen: 1, reversible: true, part: 1 },
  ],
  multiPen: true,
  partLabel: (_p, part) => `Band ${part}`,
})

const el = (id: string, type: string, params: unknown, over: Partial<DocElement> = {}): DocElement => ({
  id,
  type,
  transform: { ...IDENTITY_TRANSFORM, x: 10, y: 10 },
  params,
  pen: 0,
  ...over,
})

beforeAll(async () => {
  await initWasmForTests()
  useDoc.setState({
    profile: { ...structuredClone(PRUSA_MK4), bed: { width: 100, height: 80 }, penOffset: { x: 0, y: 0, z: 0 } },
    elements: [
      el('r', 'rect', defaultRectParams(20, 10), { name: 'Frame' }),
      el('b', 'banded', {}),
      el('f', 'rect', { ...defaultRectParams(20, 10), hatch: { pattern: 'lines', spacing: 2, angle: 45, stroke: true } }, { name: 'Filled' }),
    ],
  })
})

describe('SVG export layering', () => {
  it('nests element → part → pen, in document order', () => {
    const svg = buildSvgMarkup()
    const tags = [...svg.matchAll(/<g([^>]*)>/g)].map((m) => m[1].trim())
    // Rect: single pen, no parts → one <g> carrying element + pen attributes together.
    expect(tags[0]).toContain('data-element="Frame"')
    expect(tags[0]).toContain('data-pen=')
    // Banded element: parts in ascending tag order; band 1 spans two pens → nested pen groups, band 2
    // is single-pen → pen attributes on the part group itself.
    expect(tags[1]).toBe('data-element="Banded"')
    expect(tags[2]).toBe('data-part="Band 1"')
    expect(tags[3]).toMatch(/^stroke=.* data-pen=/)
    expect(tags[4]).toMatch(/^stroke=.* data-pen=/)
    expect(tags[5]).toMatch(/^data-part="Band 2" stroke=.* data-pen=/)
    // A hatch-filled shape splits into outline and fill.
    expect(tags[6]).toBe('data-element="Filled"')
    expect(tags[7]).toMatch(/^data-part="Outline" stroke=/)
    expect(tags[8]).toMatch(/^data-part="Fill" stroke=/)
    expect(tags.length).toBe(9)
  })
})
