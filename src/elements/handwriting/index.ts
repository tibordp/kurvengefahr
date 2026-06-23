// The handwriting element. Generation (Graves RNN-MDN + typesetter) lives entirely in the
// Rust/WASM crate, and runs in a Web Worker (see core/generation.ts) because a long line of text
// is hundreds of ms of RNN sampling — too slow for the main thread. So this type is registered as
// **async**: it has no synchronous generator. The controller drives the worker, fills the registry
// cache, and re-renders; `generateLocal` just reads the cached/stale ink.
//
// This file is now purely the element's param shape + registration.
import { registerElement } from '../registry'

export interface StrokeStyle {
  /** Varies the generated forms; same (text, seed, bias) → same ink. */
  seed: number
  /** Sampling bias (neatness). 0 = loose/natural, higher = neater/more legible. */
  bias: number
}

export interface Layout {
  /** Em height in millimetres. */
  fontSizeMm: number
  /** Line advance as a multiple of fontSize. */
  lineHeightEm: number
  /** Wrap width in millimetres. */
  maxWidthMm: number
  align: 'left' | 'center' | 'right'
  /** Forward slant in degrees (italic shear) applied on top of the model's natural slant. */
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

/** Align enum → the u8 the WASM API expects. Shared with the generation worker. */
export const ALIGN_CODE: Record<Layout['align'], number> = { left: 0, center: 1, right: 2 }

// Async (worker-backed). Locked into natural reading order unless the element opts into global
// optimization. No synchronous `generate` — the controller produces geometry off-thread.
registerElement('handwriting', {
  isLocked: (p: HandwritingParams) => !p.globalOptimize,
})

export function defaultHandwritingParams(text = 'Kurvengefahr'): HandwritingParams {
  return {
    text,
    style: { seed: 1, bias: 2.5 },
    layout: {
      fontSizeMm: 8,
      lineHeightEm: 1.5,
      maxWidthMm: 160,
      align: 'left',
      // The model already produces natural cursive slant; default extra shear to 0.
      slantDeg: 0,
    },
    globalOptimize: false,
  }
}
