// The IR contract. Everything that makes marks produces `Geometry`; everything that
// turns marks into motion consumes it. Nothing downstream of an element's `generate()`
// knows whether a stroke came from the RNN, an SVG, or a halftoned photo.

/** A point in millimetres. `pressure` is normalised 0..1 (1 = full pen-down). */
export interface Point {
  x: number
  y: number
  /** Optional per-point pressure, 0..1. Constant in MVP; reserved for effects
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

/** A non-destructive geometry effect applied to an element's (or container's) generated strokes —
 *  see `src/effects`. Effects stack in order, run in Rust (local space, before `place`), and are
 *  NOT geometry-affecting params: like `pen`, changing them is a cheap re-place, never a regenerate.
 *  Field names mirror the Rust `effects::EffectSpec` (camelCase); the discriminant is `type`. */
export type EffectType = 'roughen' | 'smooth' | 'wave' | 'sketch' | 'twist' | 'bulge' | 'taper'

interface EffectCommon {
  enabled: boolean
}
/** Hand-drawn wobble: a positional turbulence field + optional fine tremor. Seeded. */
export interface RoughenEffect extends EffectCommon {
  type: 'roughen'
  amplitudeMm: number
  detailMm: number
  tremorMm: number
  seed: number
}
/** The opposite of roughen: subdivide to `detailMm`, then Laplacian-relax (rounds corners / irons
 *  out jitter, on jagged and already-curved geometry alike). */
export interface SmoothEffect extends EffectCommon {
  type: 'smooth'
  detailMm: number
  strength: number
  iterations: number
}
/** Sinusoidal warp; >1 harmonic makes it anharmonic. */
export interface WaveEffect extends EffectCommon {
  type: 'wave'
  amplitudeMm: number
  wavelengthMm: number
  angleDeg: number
  phaseDeg: number
  harmonics: number
}
/** Multi-pass overdraw: N wandering copies of each stroke. Seeded. */
export interface SketchEffect extends EffectCommon {
  type: 'sketch'
  passes: number
  offsetMm: number
  seed: number
}
/** Swirl about the geometry centre, fading out by `radiusMm`. */
export interface TwistEffect extends EffectCommon {
  type: 'twist'
  angleDeg: number
  radiusMm: number
}
/** Radial bulge (+) / pinch (−) about the geometry centre, fading out by `radiusMm`. */
export interface BulgeEffect extends EffectCommon {
  type: 'bulge'
  strength: number
  radiusMm: number
}
/** Calligraphic pen-lift: fade per-point pressure toward each open stroke's ends (a light tip
 *  ramping up to full over the first/last few mm). Pressure-only; closed contours are left alone. */
export interface TaperEffect extends EffectCommon {
  type: 'taper'
  startMm: number
  endMm: number
  minPressure: number
}
export type EffectSpec =
  | RoughenEffect
  | SmoothEffect
  | WaveEffect
  | SketchEffect
  | TwistEffect
  | BulgeEffect
  | TaperEffect

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
  /** Container membership: this element belongs to the container element (a `group` or `clip`) with
   *  this id. Its `transform` is then **relative to that container's local space** (the container's
   *  transform composes onto it — containers nest). A `group` composes its members as one unit; a
   *  `clip` additionally clips them to a mask member. Absent ⇒ the element sits at the top level. */
  parent?: string
  /** Optional user-given display name for the Elements tree; falls back to a derived label. */
  name?: string
  /** Optional dashed stroke style (mm): each stroke is broken into `dash`-long marks separated by
   *  `gap`. Like `pen`/`transform`, it's applied downstream (in `buildPageGeometry`) — a cheap
   *  re-place/re-emit, never a regenerate. Absent = solid. */
  dash?: { dash: number; gap: number }
  /** When set on a `clip` member, this element is the clip's **mask**: it makes no marks (its closed
   *  contours bound the clip) but stays a real, editable element so unclip can restore it. */
  clipRole?: 'mask'
  /** Hidden from output: the element makes **no marks** on the canvas, preview, G-code, or export
   *  (like a toggled-off layer). Absent/false = visible. It's not a geometry param — a cheap
   *  re-place/re-emit. Its *structural* role still applies: a hidden `clip` mask keeps clipping its
   *  siblings, since that's a non-local effect, not one of the element's own marks. */
  hidden?: boolean
  /** Optional non-destructive effect stack (roughen / warp / …). Applied in order to the element's
   *  generated geometry in local space (before `place`), in Rust. Like `pen`/`pressure`, NOT a
   *  geometry param: changing it is a cheap re-effect/re-place, never a regenerate. The source stays
   *  editable (a `path`'s nodes still edit its pre-effect shape). Absent/empty = no effects. */
  effects?: EffectSpec[]
  /** Pen pressure, normalised 0..1 (1 = full). Absent = full. Like `pen`, it's *not* a
   *  geometry-affecting param: it's stamped onto the element's stroke points at concatenation
   *  (`buildPageGeometry`), so changing it is a cheap re-place/re-emit, never a regenerate. The
   *  machine profile maps it to a pen-down Z (light↔full); a profile without pressure ignores it and
   *  draws every stroke at `penZ.down`. Single-pressure for now — a future element that *natively*
   *  varies pressure sets per-point pressure in its generator (and opts out of stamping, like
   *  `multiPen`). Multi-pen types (e.g. `clip`) carry per-member pressure instead. */
  pressure?: number
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

/** Machine family — drives the output dialect/affordances. `prusa` = G-code plotters (download or
 *  PrusaLink); `axidraw` = EBB boards driven live over Web Serial (no G-code at all); `grbl` =
 *  GRBL 1.1 plotters (G-code download *or* streamed live over Web Serial). */
export type MachineKind = 'prusa' | 'axidraw' | 'grbl'

/** Binding to a printer the user granted to this app in the Bridge for PrusaLink extension;
 *  the id/name are the extension's, never creds. */
export type PrusaLinkBinding = { transport: 'prusalink'; printerId: string; printerName: string }

/** Web Serial grants have no stable id — the binding's presence just means "this profile plots
 *  over Web Serial to an EBB board". The live `SerialPort` lives in the serial store, never here. */
export type WebSerialBinding = { transport: 'webserial' }

/** Optional binding to a *physical* device this profile plots to, discriminated by transport. */
export type DeviceBinding = PrusaLinkBinding | WebSerialBinding

/** Fields every machine kind shares. `origin` lives here so the page→machine transform, drawable
 *  region and status readout stay kind-agnostic (axidraw is natively top-left and pins it there). */
interface MachineProfileBase {
  id: string
  name: string
  /** Bed size in mm. */
  bed: { width: number; height: number }
  /** Where machine (0,0) sits relative to the bed; drives the Y-flip in `toMachine`. */
  origin: 'top-left' | 'bottom-left'
  pens: Pen[]
  units: 'mm'
}

/** A G-code machine (3D printer with a pen toolhead). A feed/preamble tweak is a pure re-emit;
 *  geometry is untouched. */
export interface PrusaProfile extends MachineProfileBase {
  kind: 'prusa'
  /** Optional physical-printer binding. Absent = download-only (the default). */
  device?: PrusaLinkBinding
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
  preamble: string
  postamble: string
  /** Operator-pause macro, reused wherever the print stops for a human: between pen groups
   *  ("Change to <pen>") and at the start when a fiducial is set ("Align medium…"). Only the
   *  **pause** lives here — the positioning *moves* (clearance lift, travel to the fiducial) are
   *  emitted by `emit`, since they need the pen→nozzle transform. Template: `{message}` → the
   *  context message. May be multi-line, e.g. `G4 P500` then `M0 {message}` (Prusa shows the M0
   *  text on the LCD). Empty = no pause. */
  pause: string
}

/** An AxiDraw-style EBB machine, plotted live over Web Serial. No G-code and no Z axis: the pen is
 *  a servo (up/down only — no pressure axis, see {@link pressureEnabled}), motion is planned step
 *  segments (crate `plan.rs`). Operator pauses (fiducial, pen swaps) are app-side prompts. */
export interface AxidrawProfile extends MachineProfileBase {
  kind: 'axidraw'
  device?: WebSerialBinding
  /** Motion-planning limits: speeds mm/s, acceleration mm/s², `cornering` = junction deviation in
   *  mm (how far the path may cut a corner at speed — lower is truer and slower). */
  motion: { drawSpeed: number; travelSpeed: number; acceleration: number; cornering: number }
  /** Pen-lift servo: positions as percent 0..100 of the servo travel range, plus how long the
   *  physical lift/drop takes (motion resumes after this delay). */
  servo: { upPercent: number; downPercent: number; liftMs: number; dropMs: number }
}

/** GRBL pen on a real Z axis. Same contract as {@link PrusaProfile.penZ}: `downLight`'s presence
 *  *is* the pressure switch (present ⇒ pressure interpolates `downLight`→`down`). */
export type GrblZPen = { mode: 'z'; up: number; down: number; downLight?: number }

/** GRBL pen on a servo driven by the spindle-PWM pin — the cheap-plotter norm. `upS`/`downS` are
 *  raw `M3 S` values (0..$30, GRBL default 1000; semantics vary by servo fork — dial in with the
 *  pen test). `raiseMs`/`lowerMs` are the physical settle times, emitted as `G4` dwells. */
export type GrblServoPen = { mode: 'servo'; upS: number; downS: number; raiseMs: number; lowerMs: number }

/** A GRBL 1.1 pen plotter: G-code download or live Web Serial streaming (same rendered lines).
 *  Pen actuation is a per-profile choice (`pen.mode`): Z axis or spindle-PWM servo. No motion
 *  planning on our side — GRBL plans its own; we only stream/emit `G0`/`G1` lines. */
export interface GrblProfile extends MachineProfileBase {
  kind: 'grbl'
  device?: WebSerialBinding
  /** Real UART, must match the board (unlike the EBB's ignored USB-CDC baud). */
  baudRate: number
  /** Feed rates, mm/min (G-code convention; travel moves are `G0` rapids, so `travel` only paces
   *  Z-mode pen drops). */
  feeds: { travel: number; draw: number }
  pen: GrblZPen | GrblServoPen
  /** `$H` at job start (machine has limit switches). Off: wherever the machine sits becomes work
   *  zero (`G10 L20`) and the job walks back there at the end — the EBB convention. */
  homing: boolean
  preamble: string
  postamble: string
  /** Operator-pause macro for the *downloaded* file (`M0` support depends on the sender); live
   *  streaming replaces pauses with in-app prompts. Template: `{message}`. Empty = no pause. */
  pause: string
}

/** Global, document-level machine description, discriminated by `kind`. Editable in the UI;
 *  presets seed it — a profile's kind comes from the preset it was seeded from. */
export type MachineProfile = PrusaProfile | AxidrawProfile | GrblProfile

/** Pressure is supported by a profile when it defines a light-pressure pen-down Z (`downLight`)
 *  — which needs a real Z axis; servo pens (AxiDraw, GRBL servo mode) are up/down only. The single
 *  source of truth for "is the per-element pressure control live / does emit vary Z". */
export function pressureEnabled(profile: MachineProfile): boolean {
  if (profile.kind === 'prusa') return profile.penZ.downLight !== undefined
  if (profile.kind === 'grbl') return profile.pen.mode === 'z' && profile.pen.downLight !== undefined
  return false
}

/** The pen↔nozzle offset for kinds that have one; on an AxiDraw or GRBL plotter the pen *is* the
 *  tool (zero offset). Keeps the drawable region, park point and status readout kind-agnostic. */
export function penOffsetOf(profile: MachineProfile): { x: number; y: number; z: number } {
  return profile.kind === 'prusa' ? profile.penOffset : { x: 0, y: 0, z: 0 }
}
