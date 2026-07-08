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
  align: 'left' | 'center' | 'right' | 'justify'
  /** Forward slant in degrees (italic shear) applied on top of the model's natural slant. */
  slantDeg: number
  /** Gap between words, in ems. */
  wordSpacingEm: number
  /** Extra vertical gap after each paragraph (hard line break), in ems. */
  paragraphSpacingEm: number
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

// Async (worker-backed). Locked into natural reading order unless the element opts into global
// optimization. No synchronous `generate` — the controller produces geometry off-thread.
registerElement('handwriting', {
  isLocked: (p: HandwritingParams) => !p.globalOptimize,
  sanitizeParams: sanitizeHandwritingParams,
})

const numOr = (v: unknown, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt

/** Coerce arbitrary (persisted/imported, possibly older or malformed) params into a valid
 *  `HandwritingParams`, filling every field from defaults so the inspector/worker never see holes. */
export function sanitizeHandwritingParams(raw: unknown): HandwritingParams {
  const d = defaultHandwritingParams()
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const s = (p.style && typeof p.style === 'object' ? p.style : {}) as Record<string, any>
  const l = (p.layout && typeof p.layout === 'object' ? p.layout : {}) as Record<string, any>
  const align: Layout['align'] =
    l.align === 'left' || l.align === 'center' || l.align === 'right' || l.align === 'justify'
      ? l.align
      : d.layout.align
  return {
    text: typeof p.text === 'string' ? p.text : d.text,
    style: { seed: numOr(s.seed, d.style.seed), bias: numOr(s.bias, d.style.bias) },
    layout: {
      fontSizeMm: numOr(l.fontSizeMm, d.layout.fontSizeMm),
      lineHeightEm: numOr(l.lineHeightEm, d.layout.lineHeightEm),
      maxWidthMm: numOr(l.maxWidthMm, d.layout.maxWidthMm),
      align,
      slantDeg: numOr(l.slantDeg, d.layout.slantDeg),
      wordSpacingEm: numOr(l.wordSpacingEm, d.layout.wordSpacingEm),
      paragraphSpacingEm: numOr(l.paragraphSpacingEm, d.layout.paragraphSpacingEm),
    },
    globalOptimize: typeof p.globalOptimize === 'boolean' ? p.globalOptimize : d.globalOptimize,
  }
}

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
      wordSpacingEm: 0.5,
      paragraphSpacingEm: 0,
    },
    globalOptimize: false,
  }
}
