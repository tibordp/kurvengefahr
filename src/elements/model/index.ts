// The 3D model element: an imported STL rendered as a plottable wireframe (feature edges —
// boundaries, creases, silhouettes — with optional hidden-line removal). The model lives as a
// blob in IndexedDB (see store/images.ts); the document stores only its `modelId` plus the camera
// pose and render options. Like raster, an **async** worker-backed type — parsing + z-buffering
// an STL is too heavy for the main thread — and every knob re-renders live (debounced). All
// params cross to Rust as one JSON blob; `wireframe::Params` in `crate/src/wireframe` is the
// authoritative schema, and the clamps below mirror the Rust consumers exactly.
import { registerElement } from '../registry'

export type ModelProjection = 'perspective' | 'orthographic'

export interface ModelParams {
  /** Key into the IndexedDB blob store. The authoritative, geometry-affecting input. */
  modelId: string
  /** Physical box in mm the wireframe is framed into. Resize bakes into these (see applyScale). */
  targetWidthMm: number
  targetHeightMm: number
  /** Turntable camera: yaw spins around the model's up (Z) axis; pitch is elevation, ±85°. */
  yaw: number
  pitch: number
  /** View offset in screen fractions (±0.5), applied after projection. */
  panX: number
  panY: number
  /** Camera dolly in units of the model's bounding radius (1.3..20); also the perspective knob. */
  distance: number
  /** Both projections frame the model identically; orthographic just drops the foreshortening. */
  projection: ModelProjection
  /** Remove hidden lines (vs. drawing the full transparent wireframe). */
  occluded: boolean
  /** Edges whose faces meet at more than this dihedral angle (deg) are drawn. */
  creaseAngle: number
}

// Async (worker-backed): no synchronous `generate`. Free singletons in the optimization bag.
// Resize bakes into the physical box; everything (including the camera pose) is geometry-
// affecting, so there are no viewParams.
registerElement('model', {
  label: 'Model',
  isLocked: () => false,
  sanitizeParams: sanitizeModelParams,
  applyScale: (p: ModelParams, sx, sy) => ({
    ...p,
    targetWidthMm: p.targetWidthMm * Math.abs(sx),
    targetHeightMm: p.targetHeightMm * Math.abs(sy),
  }),
  autoRegenerate: () => true,
  provisionalExtent: (p: ModelParams) => ({ w: p.targetWidthMm, h: p.targetHeightMm }),
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Coerce arbitrary (persisted/imported, possibly malformed) params into a valid `ModelParams`.
 *  Keeps the element even if `modelId` is missing (renders as a placeholder). Clamps mirror the
 *  Rust side so persisted out-of-range values degrade identically. */
export function sanitizeModelParams(raw: unknown): ModelParams {
  const d = defaultModelParams('')
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  return {
    modelId: typeof p.modelId === 'string' ? p.modelId : '',
    targetWidthMm: Math.max(0, num(p.targetWidthMm, d.targetWidthMm)),
    targetHeightMm: Math.max(0, num(p.targetHeightMm, d.targetHeightMm)),
    yaw: num(p.yaw, d.yaw) % 360,
    pitch: clamp(num(p.pitch, d.pitch), -85, 85),
    panX: clamp(num(p.panX, d.panX), -0.5, 0.5),
    panY: clamp(num(p.panY, d.panY), -0.5, 0.5),
    distance: clamp(num(p.distance, d.distance), 1.3, 20),
    projection: p.projection === 'orthographic' ? 'orthographic' : 'perspective',
    occluded: typeof p.occluded === 'boolean' ? p.occluded : d.occluded,
    creaseAngle: clamp(num(p.creaseAngle, d.creaseAngle), 1, 180),
  }
}

export function defaultModelParams(modelId: string): ModelParams {
  return {
    modelId,
    targetWidthMm: 160,
    targetHeightMm: 110,
    yaw: 30,
    pitch: 20,
    panX: 0,
    panY: 0,
    distance: 3,
    projection: 'perspective',
    occluded: true,
    creaseAngle: 30,
  }
}
