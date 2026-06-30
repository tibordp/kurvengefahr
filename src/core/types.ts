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
  /** Which pen draws this element. Like `transform`, this is *not* a geometry-affecting param:
   *  it's stamped onto the element's strokes at concatenation (`buildPageGeometry`) and changing
   *  it is a cheap re-place/re-emit, never a regenerate. Single-pen for now — a future element
   *  type that is *natively* multi-colour sets per-stroke pens in its generator and opts out of
   *  stamping (registry `multiPen`); `pen` then acts as its base/fallback. */
  pen: PenId
  /** Optional flat-group membership — a purely organizational tag for the Elements tree (collapse,
   *  group-select, rename). It does NOT affect geometry, plot order, or the pipeline; an element
   *  with no `groupId` sits at the tree's top level. References a {@link Group} by id. */
  groupId?: string
  /** Optional user-given display name for the Elements tree; falls back to a derived label. */
  name?: string
  /** Optional dashed stroke style (mm): each stroke is broken into `dash`-long marks separated by
   *  `gap`. Like `pen`/`transform`, it's applied downstream (in `buildPageGeometry`) — a cheap
   *  re-place/re-emit, never a regenerate. Absent = solid. */
  dash?: { dash: number; gap: number }
  /** Clip-to-shape membership: this element belongs to the `clip` element with this id. Its
   *  `transform` is then **relative to that clip's local space** (so the clip's transform composes
   *  onto it — clips nest). The clip renders/plots only the part of its members inside the mask. */
  clipParent?: string
  /** When set on a clip member, this element is the clip's **mask**: it makes no marks (its closed
   *  contours bound the clip) but stays a real, editable element so unclip can restore it. */
  clipRole?: 'mask'
  /** Pen pressure, normalised 0..1 (1 = full). Absent = full. Like `pen`, it's *not* a
   *  geometry-affecting param: it's stamped onto the element's stroke points at concatenation
   *  (`buildPageGeometry`), so changing it is a cheap re-place/re-emit, never a regenerate. The
   *  machine profile maps it to a pen-down Z (light↔full); a profile without pressure ignores it and
   *  draws every stroke at `penZ.down`. Single-pressure for now — a future element that *natively*
   *  varies pressure sets per-point pressure in its generator (and opts out of stamping, like
   *  `multiPen`). Multi-pen types (e.g. `clip`) carry per-member pressure instead. */
  pressure?: number
}

/** A flat (non-nesting) organizational group of elements, shown as a collapsible node in the
 *  Elements tree. Membership lives on each element's `groupId`; this just holds the display state. */
export interface Group {
  id: string
  name: string
  collapsed: boolean
}

export interface Pen {
  id: PenId
  name: string
  /** Display colour for the canvas (not sent to the machine). */
  color: string
}

/** A page-space alignment point. At most one per document; produces no ink. At the start of a
 *  print the machine travels over it at a high (clearance) Z and pauses (`M0`) so the operator can
 *  align the medium to where features will be drawn. Its position uses the same pen→nozzle
 *  transform as stroke points (`toMachine` − penOffset). */
export interface Fiducial {
  x: number
  y: number
}

/** Machine family — drives the output dialect/affordances. Only Prusa (G-code) today; the
 *  discriminator is here so a future type (e.g. an AxiDraw over Web Serial) slots in without
 *  reshaping the profile. */
export type MachineKind = 'prusa'

/** Optional binding to a *physical* device this profile plots to, discriminated by transport so new
 *  transports (e.g. `webserial`) can be added later. `prusalink` targets a printer the user granted
 *  to this app in the PrusaLink Bridge extension; the id/name are the extension's, never creds. */
export type DeviceBinding = { transport: 'prusalink'; printerId: string; printerName: string }

/** Global, document-level machine description. A feed/preamble tweak is a pure re-emit;
 *  geometry is untouched. Editable in the UI; presets seed it. */
export interface MachineProfile {
  id: string
  name: string
  /** Machine family. Currently always `'prusa'`; the connectivity UI keys off it, and emit/Z will
   *  branch on it when a second kind lands. */
  kind: MachineKind
  /** Optional physical-printer binding. Absent = download-only (the default). */
  device?: DeviceBinding
  /** Bed size in mm. */
  bed: { width: number; height: number }
  /** Where machine (0,0) sits relative to the bed; drives the Y-flip in `toMachine`. */
  origin: 'top-left' | 'bottom-left'
  /** Feed rates, mm/min. */
  feeds: { travel: number; draw: number }
  /** Pen Z heights (mm). `up` = clearance; `down` = the pen-down height at **full** pressure.
   *  `downLight` is the optional pen-down Z at **minimum** pressure — its presence *is* the
   *  pressure switch: present ⇒ a stroke's pressure (0..1) interpolates `downLight` (light) →
   *  `down` (full); absent ⇒ pen up/down only, every stroke draws at `down` and the per-element
   *  pressure control is disabled in the UI (values kept, not cleared). See {@link pressureEnabled}. */
  penZ: { up: number; down: number; downLight?: number }
  /** Pen tip position relative to the nozzle, machine axes (mm). G-code commands the nozzle,
   *  so emitted coords = pen target − offset. Nonzero x/y shrink the reachable (drawable) area;
   *  z shifts the commanded Z. */
  penOffset: { x: number; y: number; z: number }
  pens: Pen[]
  preamble: string
  postamble: string
  /** Operator-pause macro, reused wherever the print stops for a human: between pen groups
   *  ("Change to <pen>") and at the start when a fiducial is set ("Align medium…"). Only the
   *  **pause** lives here — the positioning *moves* (clearance lift, travel to the fiducial) are
   *  emitted by `emit`, since they need the pen→nozzle transform. Template: `{message}` → the
   *  context message. May be multi-line, e.g. `G4 P500` then `M0 {message}` (Prusa shows the M0
   *  text on the LCD). Empty = no pause. */
  pause: string
  units: 'mm'
}

/** Pressure is supported by a profile when it defines a light-pressure pen-down Z (`penZ.downLight`).
 *  The single source of truth for "is the per-element pressure control live / does emit vary Z". */
export function pressureEnabled(profile: MachineProfile): boolean {
  return profile.penZ.downLight !== undefined
}
