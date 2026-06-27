// The `clip` element: a container whose displayed/plotted geometry is its member elements clipped to
// a mask member, computed in the pipeline (core/pipeline/clipGeometry.ts) and on the canvas by
// ClipNode — NOT here. Its registered `generate` is empty so it's treated as a plain sync type (no
// worker, never "dirty"); `multiPen` keeps its members' pens through clipping. Members are normal
// top-level elements tagged `clipParent`; the mask additionally tagged `clipRole: 'mask'`.
import { registerElement } from '../registry'

export type ClipParams = Record<string, never>

export const defaultClipParams = (): ClipParams => ({})

registerElement('clip', {
  generate: () => [],
  multiPen: true,
  isLocked: () => false,
  sanitizeParams: () => ({}),
})
