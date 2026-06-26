import { registerElement } from '../registry'
import { rectGeometry } from '../../core/wasm/shapes'
import type { Geometry } from '../../core/types'
import { type Hatch, defaultHatch, sanitizeHatch, rectFill } from './hatch'

export interface RectParams {
  /** Width / height in mm, local origin at (0,0). */
  w: number
  h: number
  /** Corner radius in mm (0 = sharp). */
  cornerRadius: number
  hatch: Hatch
}

export const defaultRectParams = (w = 40, h = 25): RectParams => ({
  w,
  h,
  cornerRadius: 0,
  hatch: defaultHatch(),
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

registerElement('rect', {
  generate: (p: RectParams): Geometry => {
    const w = Math.max(0, p.w)
    const h = Math.max(0, p.h)
    const outline = rectGeometry(w, h, Math.max(0, p.cornerRadius))
    const fill = rectFill(w, h, outline[0]?.points ?? [], p.hatch)
    return [...(p.hatch.stroke ? outline : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      w: Math.max(0, num(o.w, 40)),
      h: Math.max(0, num(o.h, 25)),
      cornerRadius: Math.max(0, num(o.cornerRadius, 0)),
      hatch: sanitizeHatch(o.hatch),
    } as RectParams
  },
  // Resize bakes into real W/H; corner radius is an absolute mm value and stays fixed (Rust clamps
  // it to ≤ half the shorter side if the rect gets small).
  applyScale: (p: RectParams, sx, sy) => ({ ...p, w: p.w * Math.abs(sx), h: p.h * Math.abs(sy) }),
})
