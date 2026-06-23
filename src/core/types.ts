// The IR contract. Everything that makes marks produces `Geometry`; everything that
// turns marks into motion consumes it. Nothing downstream of an element's `generate()`
// knows whether a stroke came from the RNN, an SVG, or a halftoned photo.

/** A point in millimetres. `pressure` is normalised 0..1 (1 = full pen-down). */
export interface Point {
  x: number
  y: number
  /** Optional per-point pressure, 0..1. Constant in MVP; reserved for filters
   *  (e.g. pen-lift taper over the last few mm of a stroke). */
  pressure?: number
}

export type PenId = number

/** One pen-down polyline. The atom of the IR. */
export interface Stroke {
  /** Ordered points, millimetres. Element-local until `place()` lifts them to page space. */
  points: Point[]
  /** Pen / layer id. `Emit` groups by this and drops an M0 pause between groups. */
  pen: PenId
  /** If true the optimizer may reverse the stroke (direction is free, e.g. handwriting/vector).
   *  Set false when direction carries meaning. */
  reversible: boolean
  /** Per-stroke feed override (mm/min). Resolved in `Emit` as
   *  `stroke.feed ?? element.feed ?? profile.feeds.draw`. Unused in MVP. */
  feed?: number
  /** Chain id. Strokes sharing a nonzero group are one locked, contiguous, fixed-direction
   *  unit the optimizer plots together (internal pen-ups and all). 0/undefined = free
   *  singleton in the global bag. Assigned at element concatenation (`buildPageGeometry`). */
  group?: number
}

/** The entire interface between "things that make marks" and "things that make motion." */
export type Geometry = Stroke[]

/** Affine local→page transform, decomposed to match Konva's node model and the inspector.
 *  Translation is millimetres in page space; rotation is degrees. */
export interface Transform {
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
}

export const IDENTITY_TRANSFORM: Transform = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
}

/** A document element: owns a transform (manipulated on canvas) and params (edited in the
 *  inspector). Its geometry is produced by the type's registered generator and memoized. */
export interface DocElement<TParams = unknown> {
  id: string
  type: string
  transform: Transform
  params: TParams
}

export interface Pen {
  id: PenId
  name: string
  /** Display colour for the canvas (not sent to the machine). */
  color: string
}

/** Global, document-level machine description. A feed/preamble tweak is a pure re-emit;
 *  geometry is untouched. Editable in the UI; presets seed it. */
export interface MachineProfile {
  id: string
  name: string
  /** Bed size in mm. */
  bed: { width: number; height: number }
  /** Where machine (0,0) sits relative to the bed; drives the Y-flip in `toMachine`. */
  origin: 'top-left' | 'bottom-left'
  /** Feed rates, mm/min. */
  feeds: { travel: number; draw: number }
  /** Pen Z heights (mm) and dwell (ms) after each up/down move. */
  penZ: { up: number; down: number; dwell: number }
  /** Pen tip position relative to the nozzle, machine axes (mm). G-code commands the nozzle,
   *  so emitted coords = pen target − offset. Nonzero x/y shrink the reachable (drawable) area;
   *  z shifts the commanded Z. */
  penOffset: { x: number; y: number; z: number }
  pens: Pen[]
  preamble: string
  postamble: string
  units: 'mm'
}
