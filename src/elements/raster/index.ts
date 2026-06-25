// The raster image element. The source image lives as a blob in IndexedDB (see store/images.ts);
// the document only stores its `imageId` plus the vectorization params. Like handwriting, this is
// an **async** type — the trace runs in a Web Worker (loading the blob + decoding the image are
// async, and tracing a few-MP image is too heavy for the main thread). The controller drives the
// worker, fills the registry cache, and re-renders; `generateLocal` just reads the cached strokes.
//
// This file is purely the element's param shape + registration.
import { registerElement } from '../registry'

/** Vectorization method. Only outline tracing today; the field is the seam for adding more
 *  (e.g. grayscale hatching) without a pipeline change. */
export type RasterMethod = 'contours'

/** Method name → the u32 the WASM `vectorize_image` API expects. Shared with the vectorize worker. */
export const METHOD_CODE: Record<RasterMethod, number> = { contours: 0 }

export interface RasterParams {
  /** Key into the IndexedDB image store. The authoritative, geometry-affecting input. */
  imageId: string
  /** Stored (post-downsample) pixel dims — cached so the inspector/aspect math needs no blob. */
  naturalWidth: number
  naturalHeight: number
  /** Physical render box in mm; the pixel grid is fit into it (px→mm) and it sizes the canvas
   *  preview. Resize bakes into these (see applyScale). */
  targetWidthMm: number
  targetHeightMm: number
  method: RasterMethod
  /** Luma threshold 0..255; ink = darker. */
  threshold: number
  /** Flip ink/paper. */
  invert: boolean
  /** RDP simplification tolerance in mm. */
  simplifyTol: number
  /** Despeckle: drop traced contours under this many px². */
  minArea: number
  /** Display-only: draw the faint source image under the traced strokes. Not a geometry input
   *  (see registry `viewParams`), so toggling it never re-traces. */
  showUnderlay: boolean
}

// Async (worker-backed): no synchronous `generate`. Free singletons in the optimization bag (a
// traced image is not a locked chain). Resize bakes into the physical box so tracing stays crisp at
// any size (and the element goes dirty → Regenerate, like handwriting edits). Single pen.
registerElement('raster', {
  isLocked: () => false,
  sanitizeParams: sanitizeRasterParams,
  applyScale: (p: RasterParams, sx, sy) => ({
    ...p,
    targetWidthMm: p.targetWidthMm * Math.abs(sx),
    targetHeightMm: p.targetHeightMm * Math.abs(sy),
  }),
  // Outline tracing is cheap enough to re-trace live (debounced) as params change. A future heavier
  // method (e.g. tonal hatching) would return false here and fall back to manual Regenerate.
  autoRegenerate: (p: RasterParams) => p.method === 'contours',
  // The mm box the trace is fit into — lets the canvas rescale stale ink to a new size during a
  // resize, instead of flashing the old size until the re-trace lands.
  provisionalExtent: (p: RasterParams) => ({ w: p.targetWidthMm, h: p.targetHeightMm }),
  // `showUnderlay` only affects display, not the strokes → keep it out of the geometry hash.
  viewParams: ['showUnderlay'],
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Coerce arbitrary (persisted/imported, possibly older or malformed) params into a valid
 *  `RasterParams`. Keeps the element even if `imageId` is missing (it renders as a placeholder; the
 *  blob's existence is the storage layer's concern, not the sanitizer's). */
export function sanitizeRasterParams(raw: unknown): RasterParams {
  const d = defaultRasterParams('')
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  return {
    imageId: typeof p.imageId === 'string' ? p.imageId : '',
    naturalWidth: Math.max(0, num(p.naturalWidth, d.naturalWidth)),
    naturalHeight: Math.max(0, num(p.naturalHeight, d.naturalHeight)),
    targetWidthMm: Math.max(0, num(p.targetWidthMm, d.targetWidthMm)),
    targetHeightMm: Math.max(0, num(p.targetHeightMm, d.targetHeightMm)),
    method: p.method === 'contours' ? p.method : d.method,
    threshold: clamp(num(p.threshold, d.threshold), 0, 255),
    invert: typeof p.invert === 'boolean' ? p.invert : d.invert,
    simplifyTol: Math.max(0, num(p.simplifyTol, d.simplifyTol)),
    minArea: Math.max(0, num(p.minArea, d.minArea)),
    showUnderlay: typeof p.showUnderlay === 'boolean' ? p.showUnderlay : d.showUnderlay,
  }
}

export function defaultRasterParams(
  imageId: string,
  naturalWidth = 0,
  naturalHeight = 0,
  targetWidthMm = 100,
  targetHeightMm = 100,
): RasterParams {
  return {
    imageId,
    naturalWidth,
    naturalHeight,
    targetWidthMm,
    targetHeightMm,
    method: 'contours',
    threshold: 128,
    invert: false,
    simplifyTol: 0.3,
    minArea: 8,
    showUnderlay: true,
  }
}
