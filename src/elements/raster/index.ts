// The raster image element. The source image lives as a blob in IndexedDB (see store/images.ts);
// the document only stores its `imageId` plus the stylization params. Like handwriting, this is an
// **async** type — tracing runs in a Web Worker (loading the blob + decoding the image are async,
// and stylizing a few-MP image is too heavy for the main thread). The controller drives the worker,
// fills the registry cache, and re-renders; `generateLocal` just reads the cached strokes.
//
// One image, many renderings: `method` picks a stylization (outline tracing, hatching, TSP art,
// flow field, spiral, topographic contours, squiggle scanlines). Each is a self-contained Rust routine
// producing the same `Stroke[]`; the params object below is the *union* of every method's knobs, and
// the inspector shows only the active method's subset. All of it is marshalled to Rust as one JSON
// blob (see the vectorize worker) — `raster::Params` is the authoritative schema.
import { registerElement } from '../registry'

/** Stylization method. Each maps to a Rust routine in `crate/src/raster/`. */
export type RasterMethod =
  | 'contours' // faithful outline tracing
  | 'centerline' // skeleton/centreline tracing for line art (one stroke per line)
  | 'contourmap' // topographic iso-tone lines
  | 'hatch' // engraving-style tonal cross-hatch
  | 'pressurehatch' // even single hatch; tone rides on per-point pen pressure (darker = harder)
  | 'scanlines' // squiggle scanlines (wiggle ∝ darkness)
  | 'tsp' // one continuous line threaded through a density-weighted point cloud
  | 'voronoi' // Voronoi mosaic of a density-weighted point cloud (small cells where dark)
  | 'flowfield' // streamlines flowing along the image's edges
  | 'spiral' // one radially-modulated Archimedean spiral

/** Methods that use a random seed (so the inspector offers a re-roll). */
export const SEEDED_METHODS: ReadonlySet<RasterMethod> = new Set(['tsp', 'voronoi', 'flowfield'])

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
  /** Flip ink/paper (trace the light areas instead). Shared by all methods. */
  invert: boolean
  /** Seed for the randomized methods (tsp/flowfield). */
  seed: number

  // --- contours / contourmap ---
  /** Luma threshold 0..255; ink = darker (contours). */
  threshold: number
  /** Elastic-band smoothing / RDP tolerance in mm (contours). */
  simplifyTol: number
  /** Despeckle: drop traced contours under this many px² (contours). */
  minArea: number

  // --- hatch / scanlines / spiral / contourmap ---
  /** Line spacing / spiral pitch in mm. */
  spacing: number
  /** Base hatch / flow angle in degrees. */
  angle: number
  /** Tone bands (hatch cross-hatch depth; contourmap iso-levels). */
  levels: number
  /** Wiggle amplitude in mm (scanlines / spiral). */
  amplitude: number
  /** Wiggle frequency (scanlines / spiral). */
  frequency: number
  /** Pressure hatch: contrast of the darkness→pressure map (1 = linear, >1 expands, <1 compresses). */
  pressureContrast: number

  // --- tsp / flowfield ---
  /** 0..1 density of sampled points / seeds. */
  detail: number
  /** Flow streamline max length (integration steps). */
  flowSteps: number

  /** Display-only: draw the faint source image under the traced strokes. Not a geometry input
   *  (see registry `viewParams`), so toggling it never re-traces. */
  showUnderlay: boolean
}

// Async (worker-backed): no synchronous `generate`. Free singletons in the optimization bag. Resize
// bakes into the physical box so tracing stays crisp at any size (and the element goes dirty →
// Regenerate, like handwriting edits). Single pen.
registerElement('raster', {
  label: 'Image',
  isLocked: () => false,
  sanitizeParams: sanitizeRasterParams,
  applyScale: (p: RasterParams, sx, sy) => ({
    ...p,
    targetWidthMm: p.targetWidthMm * Math.abs(sx),
    targetHeightMm: p.targetHeightMm * Math.abs(sy),
  }),
  // Every method re-traces live (debounced) as params change — they're all fast enough off-thread,
  // so there's no manual "Regenerate" for raster (unlike handwriting's slow model run).
  autoRegenerate: () => true,
  // The mm box the trace is fit into — lets the canvas rescale stale ink to a new size during a
  // resize, instead of flashing the old size until the re-trace lands.
  provisionalExtent: (p: RasterParams) => ({ w: p.targetWidthMm, h: p.targetHeightMm }),
  // `showUnderlay` only affects display, not the strokes → keep it out of the geometry hash.
  viewParams: ['showUnderlay'],
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const VALID_METHODS: ReadonlySet<string> = new Set([
  'contours', 'centerline', 'contourmap', 'hatch', 'pressurehatch', 'scanlines', 'tsp', 'voronoi',
  'flowfield', 'spiral',
])

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
    method: VALID_METHODS.has(p.method) ? p.method : d.method,
    invert: typeof p.invert === 'boolean' ? p.invert : d.invert,
    seed: Math.max(0, Math.floor(num(p.seed, d.seed))),
    threshold: clamp(num(p.threshold, d.threshold), 0, 255),
    simplifyTol: Math.max(0, num(p.simplifyTol, d.simplifyTol)),
    minArea: Math.max(0, num(p.minArea, d.minArea)),
    spacing: Math.max(0.1, num(p.spacing, d.spacing)),
    angle: num(p.angle, d.angle),
    levels: clamp(Math.floor(num(p.levels, d.levels)), 1, 16),
    amplitude: Math.max(0, num(p.amplitude, d.amplitude)),
    frequency: Math.max(0.1, num(p.frequency, d.frequency)),
    pressureContrast: clamp(num(p.pressureContrast, d.pressureContrast), 0, 4),
    detail: clamp(num(p.detail, d.detail), 0, 1),
    flowSteps: clamp(Math.floor(num(p.flowSteps, d.flowSteps)), 4, 4000),
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
    invert: false,
    seed: 1,
    threshold: 128,
    simplifyTol: 0.3,
    minArea: 8,
    spacing: 1.5,
    angle: 45,
    levels: 4,
    amplitude: 1.2,
    frequency: 5,
    pressureContrast: 1,
    detail: 0.5,
    flowSteps: 80,
    showUnderlay: true,
  }
}
