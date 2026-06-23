// The handwriting element. Generation (synthetic StrokeModel + Typesetter) lives entirely in
// the Rust/WASM crate; this file is the thin JS seam: map params → WASM call → Geometry, and
// register the element type. Swapping the synthetic model for the Graves RNN happens in Rust,
// behind `generate_handwriting` — nothing here changes.
//
// `generate` is synchronous because the WASM module is instantiated before first render
// (see main.tsx), so element memoization and canvas rendering stay synchronous.
import type { Geometry } from '../../core/types'
import { registerElement } from '../registry'
import { generate_handwriting } from '../../core/wasm'
import { unflatten } from '../../core/wasm/serde'

export interface StrokeStyle {
  /** Varies the generated forms; same (text, seed) → same ink. */
  seed: number
}

export interface Layout {
  /** Em height in millimetres. */
  fontSizeMm: number
  /** Line advance as a multiple of fontSize. */
  lineHeightEm: number
  /** Wrap width in millimetres. */
  maxWidthMm: number
  align: 'left' | 'center' | 'right'
  /** Forward slant in degrees (italic shear). */
  slantDeg: number
}

export interface HandwritingParams {
  text: string
  style: StrokeStyle
  layout: Layout
  /** When false (default), the element's strokes are kept as one locked chain and plotted in
   *  natural reading order. When true, they go into the global optimization bag with everything
   *  else (free reordering + reversal). */
  globalOptimize: boolean
}

const ALIGN_CODE: Record<Layout['align'], number> = { left: 0, center: 1, right: 2 }

function generate(params: HandwritingParams): Geometry {
  const { text, layout, style } = params
  const buf = generate_handwriting(
    text,
    layout.fontSizeMm,
    layout.lineHeightEm,
    layout.maxWidthMm,
    ALIGN_CODE[layout.align],
    layout.slantDeg,
    style.seed >>> 0,
  )
  // Copy the typed arrays out before freeing the Rust-owned struct.
  const geom = unflatten({
    xy: buf.xy,
    pressure: buf.pressure,
    offsets: buf.offsets,
    pen: buf.pen,
    reversible: buf.reversible,
    group: buf.group,
  })
  buf.free()
  return geom
}

// Locked (natural order) unless the element opts into global optimization.
registerElement('handwriting', generate, {
  isLocked: (p: HandwritingParams) => !p.globalOptimize,
})

export function defaultHandwritingParams(text = 'Kurvengefahr'): HandwritingParams {
  return {
    text,
    style: { seed: 1 },
    layout: {
      fontSizeMm: 8,
      lineHeightEm: 1.5,
      maxWidthMm: 160,
      align: 'left',
      slantDeg: 8,
    },
    globalOptimize: false,
  }
}
