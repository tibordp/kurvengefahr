// The `text` element: typed text laid out as strokes by Rust, in two modes. SINGLE uses Hershey
// single-stroke fonts (centrelines — the staple plotter text); OUTLINE uses TTF glyph outlines,
// which are closed contours we hatch-fill (even-odd ⇒ holes in O/A/e). Synchronous, like the other
// shapes. Scale stays in the transform (no applyScale), like handwriting.
import { registerElement } from '../registry'
import { textGeometry } from '../../core/wasm/shapes'
import { type Hatch, defaultHatch, sanitizeHatch, pathFill } from '../shapes/hatch'
import type { Geometry, Point } from '../../core/types'

export type TextMode = 'single' | 'outline'
export type TextAlign = 'left' | 'center' | 'right' | 'justify'

export interface TextParams {
  text: string
  mode: TextMode
  /** Hershey font key (single) or 'sans' | 'serif' | 'mono' (outline). */
  font: string
  /** Em size in mm. */
  size: number
  letterSpacing: number
  lineSpacing: number
  align: TextAlign
  /** Wrap width in mm; 0 = no wrap (lines break only on newlines). Justify needs a wrap width. */
  maxWidth: number
  /** Fill for outline mode (ignored in single mode). Default 'none' ⇒ glyph outlines only. */
  hatch: Hatch
}

/** Single-stroke (Hershey) fonts, by key + label. */
export const HERSHEY_FONTS = [
  { key: 'futural', name: 'Sans' },
  { key: 'futuram', name: 'Sans Bold' },
  { key: 'timesr', name: 'Serif' },
  { key: 'timesrb', name: 'Serif Bold' },
  { key: 'scripts', name: 'Script' },
  { key: 'gothiceng', name: 'Gothic' },
]
/** Outline (TTF) fonts. */
export const OUTLINE_FONTS = [
  { key: 'sans', name: 'Sans' },
  { key: 'serif', name: 'Serif' },
  { key: 'mono', name: 'Mono' },
]

export const defaultTextParams = (text = 'Text'): TextParams => ({
  text,
  mode: 'single',
  font: 'futural',
  size: 10,
  letterSpacing: 0,
  lineSpacing: 1.3,
  align: 'left',
  maxWidth: 0,
  hatch: defaultHatch(),
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

registerElement('text', {
  generate: (p: TextParams): Geometry => {
    if (!p.text.trim()) return []
    const geom = textGeometry(
      JSON.stringify({
        text: p.text,
        mode: p.mode,
        font: p.font,
        size: p.size,
        letter_spacing: p.letterSpacing,
        line_spacing: p.lineSpacing,
        align: p.align,
        max_width: p.maxWidth,
      }),
    )
    if (p.mode !== 'outline') return geom // single-stroke centrelines
    // Outline glyphs are closed contours: stroke them and/or hatch-fill them (even-odd holes).
    const rings: Point[][] = geom.map((s) => s.points)
    const fill = p.hatch.pattern !== 'none' ? pathFill(rings, p.hatch) : []
    return [...(p.hatch.stroke ? geom : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const mode: TextMode = o.mode === 'outline' ? 'outline' : 'single'
    const align = o.align === 'center' || o.align === 'right' || o.align === 'justify' ? o.align : 'left'
    return {
      text: str(o.text, ''),
      mode,
      font: str(o.font, mode === 'outline' ? 'sans' : 'futural'),
      size: Math.max(0.5, num(o.size, 10)),
      letterSpacing: num(o.letterSpacing, 0),
      lineSpacing: Math.max(0.5, num(o.lineSpacing, 1.3)),
      align,
      maxWidth: Math.max(0, num(o.maxWidth, 0)),
      hatch: sanitizeHatch(o.hatch),
    } as TextParams
  },
})
