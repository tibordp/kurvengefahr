import { registerElement } from '../registry'
import { ellipseGeometry } from '../../core/wasm/shapes'
import type { Geometry } from '../../core/types'
import { type Hatch, defaultHatch, sanitizeHatch, ellipseFill } from './hatch'

export interface EllipseParams {
  /** Radii in mm; the ellipse is centred at the local origin (0,0). */
  rx: number
  ry: number
  hatch: Hatch
}

export const defaultEllipseParams = (rx = 20, ry = 20): EllipseParams => ({ rx, ry, hatch: defaultHatch() })

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

registerElement('ellipse', {
  generate: (p: EllipseParams): Geometry => {
    const rx = Math.max(0, p.rx)
    const ry = Math.max(0, p.ry)
    const outline = ellipseGeometry(rx, ry)
    const fill = ellipseFill(rx, ry, outline[0]?.points ?? [], p.hatch)
    return [...(p.hatch.stroke ? outline : []), ...fill]
  },
  isLocked: () => false,
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    return {
      rx: Math.max(0, num(o.rx, 20)),
      ry: Math.max(0, num(o.ry, 20)),
      hatch: sanitizeHatch(o.hatch),
    } as EllipseParams
  },
  applyScale: (p: EllipseParams, sx, sy) => ({ ...p, rx: p.rx * Math.abs(sx), ry: p.ry * Math.abs(sy) }),
})
