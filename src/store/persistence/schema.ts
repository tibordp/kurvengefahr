// Versioned serialization for everything we persist or import/export. The cardinal rule here is
// **never throw**: a corrupt localStorage entry, a foreign file, or a document written by a future
// app version must degrade gracefully (skip / report), never crash the app. Every loader is a total
// function returning an `Outcome`.
//
// Compatibility, both directions:
//   • Backward (new app, old data): stepwise `migrations[v]` bump the blob to CURRENT, then
//     sanitizers fill any missing fields from defaults — so a field added in a later schema is
//     simply backfilled when loading older data.
//   • Forward (old app, newer data): a `schemaVersion` greater than CURRENT yields `unsupported`;
//     callers report it and leave the stored bytes untouched rather than mangling them.
import type { DocElement, Fiducial, MachineProfile, Transform } from '../../core/types'
import { IDENTITY_TRANSFORM } from '../../core/types'
import { AXIDRAW_V3, GRBL_PLOTTER, PRUSA_MK4 } from '../profiles'
import { isContainer, isKnownType, sanitizeParams } from '../../elements/registry'
import { sanitizeEffects } from '../../effects/registry'

// v2: `path` params went multi-contour ({nodes,closed} → {contours:[{nodes,closed}]}). No migration
// step is needed — the path sanitizer coerces the old single-contour shape — but the bump makes an
// older app reject v2 docs as `unsupported` instead of silently dropping their paths.
// v3: clip-to-shape — a `clip` element type plus optional `clipParent`/`clipRole` tags. Additive
// optional fields backfill via the sanitizers, so no migration step; the bump just fences off older
// apps that don't know how to render clips.
// v4: pen pressure — optional per-element `pressure` plus a profile `pressure` block. Additive and
// backfilled, so no migration step; the bump fences off older apps that draw every stroke at down Z.
// v5: containers unified — plain `groups` (a separate array + per-element `groupId`) and clips
// (`clipParent`) collapse into a single container model: a `group`/`clip` element + each member's
// `parent`. No migration step (buildout, no back-compat) — older docs just load without their old
// grouping/clips, which the sanitizers tolerate.
// v6: per-element non-destructive `effects` stack. Additive optional field, backfilled to [].
// v7: machine-kind union — profiles are now `prusa` | `axidraw` shapes (library v2 likewise). No
// migration step (prusa data is unchanged; the sanitizer dispatches on `kind`); the bump fences off
// older apps that coerce every profile to prusa and would mangle an axidraw one.
// v8: the `logo` element type. No migration (purely additive); the bump makes older apps report a
// doc containing Logo programs as `unsupported` instead of silently dropping those elements.
// v9: the `grbl` machine kind (library v3 likewise). No migration (additive kind; the sanitizer
// dispatches on `kind`); the bump fences off older apps that coerce a grbl profile to prusa.
// v10: the `model` element type (STL → wireframe); the blob store / `.kgz` container now also
// carry STL model blobs (`params.modelId`, `images/<id>.stl`). No migration (purely additive);
// the bump makes older apps report a doc containing models as `unsupported` instead of dropping
// them.
export const CURRENT_DOC_SCHEMA = 10
export const CURRENT_LIBRARY_SCHEMA = 3
export const CURRENT_TOOLS_SCHEMA = 1

export const DOC_FILE_KIND = 'kurvengefahr/document'
export const PROFILES_FILE_KIND = 'kurvengefahr/profiles'
export const TOOLS_FILE_KIND = 'kurvengefahr/tools'

/** The mutable content of a document (what the working store holds). */
export interface DocSnapshot {
  elements: DocElement[]
  profile: MachineProfile
  selectedIds: string[]
  /** The single alignment fiducial (page-space mm), or null. */
  fiducial: Fiducial | null
}

/** A document as stored under `kg-doc:<id>` — snapshot + identity/metadata. */
export interface StoredDoc extends DocSnapshot {
  schemaVersion: number
  id: string
  name: string
  updatedAt: number
}

export type Outcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsupported'; message: string } // newer schemaVersion than we understand
  | { status: 'invalid'; message: string } // corrupt / foreign / unparseable

// ---- primitive coercers -------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object'
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

function sanitizeTransform(t: unknown): Transform {
  const o = isObj(t) ? t : {}
  return {
    x: num(o.x, IDENTITY_TRANSFORM.x),
    y: num(o.y, IDENTITY_TRANSFORM.y),
    rotation: num(o.rotation, IDENTITY_TRANSFORM.rotation),
    scaleX: num(o.scaleX, IDENTITY_TRANSFORM.scaleX),
    scaleY: num(o.scaleY, IDENTITY_TRANSFORM.scaleY),
  }
}

function sanitizePen(p: unknown, i: number) {
  const o = isObj(p) ? p : {}
  return { id: num(o.id, i), name: str(o.name, `Pen ${i + 1}`), color: str(o.color, '#1a1a1a') }
}

/** Coerce any object into a valid MachineProfile, dispatching on `kind` (unknown kinds coerce to
 *  prusa — the pre-union shape) and backfilling from the kind's base preset so fields added in a
 *  later schema are present even when loading an older profile. Exported for the library + imports. */
export function sanitizeProfile(p: unknown): MachineProfile {
  if (isObj(p) && p.kind === 'axidraw') return sanitizeAxidrawProfile(p)
  if (isObj(p) && p.kind === 'grbl') return sanitizeGrblProfile(p)
  return sanitizePrusaProfile(isObj(p) ? p : {})
}

function sanitizePrusaProfile(p: Record<string, any>): MachineProfile {
  const base = PRUSA_MK4
  const pens = Array.isArray(p.pens) && p.pens.length ? p.pens.map(sanitizePen) : structuredClone(base.pens)
  // Physical-printer binding: keep only a well-formed prusalink binding, else drop (download-only).
  const d = p.device
  const device =
    isObj(d) && d.transport === 'prusalink' && typeof d.printerId === 'string' && typeof d.printerName === 'string'
      ? ({ transport: 'prusalink', printerId: d.printerId, printerName: d.printerName } as const)
      : undefined
  return {
    id: str(p.id, base.id),
    name: str(p.name, base.name),
    kind: 'prusa',
    ...(device ? { device } : {}),
    bed: { width: num(p.bed?.width, base.bed.width), height: num(p.bed?.height, base.bed.height) },
    origin: p.origin === 'top-left' || p.origin === 'bottom-left' ? p.origin : base.origin,
    feeds: { travel: num(p.feeds?.travel, base.feeds.travel), draw: num(p.feeds?.draw, base.feeds.draw) },
    penZ: {
      up: num(p.penZ?.up, base.penZ.up),
      down: num(p.penZ?.down, base.penZ.down),
      // Optional: present ⇒ pressure on. Keep only a finite number, else drop (pen up/down only).
      ...(typeof p.penZ?.downLight === 'number' && Number.isFinite(p.penZ.downLight)
        ? { downLight: p.penZ.downLight }
        : {}),
    },
    penOffset: { x: num(p.penOffset?.x, 0), y: num(p.penOffset?.y, 0), z: num(p.penOffset?.z, 0) },
    pens,
    preamble: str(p.preamble, base.preamble),
    postamble: str(p.postamble, base.postamble),
    pause: str(p.pause, base.pause),
    units: 'mm',
  }
}

function sanitizeAxidrawProfile(p: Record<string, any>): MachineProfile {
  const base = AXIDRAW_V3
  const pens = Array.isArray(p.pens) && p.pens.length ? p.pens.map(sanitizePen) : structuredClone(base.pens)
  const pct = (v: unknown, d: number) => Math.min(100, Math.max(0, num(v, d)))
  return {
    id: str(p.id, base.id),
    name: str(p.name, base.name),
    kind: 'axidraw',
    // Web Serial binding carries no payload — keep it iff well-formed.
    ...(isObj(p.device) && p.device.transport === 'webserial' ? { device: { transport: 'webserial' as const } } : {}),
    bed: { width: num(p.bed?.width, base.bed.width), height: num(p.bed?.height, base.bed.height) },
    origin: 'top-left', // an AxiDraw's home corner — not editable for this kind
    motion: {
      drawSpeed: num(p.motion?.drawSpeed, base.motion.drawSpeed),
      travelSpeed: num(p.motion?.travelSpeed, base.motion.travelSpeed),
      acceleration: num(p.motion?.acceleration, base.motion.acceleration),
      cornering: num(p.motion?.cornering, base.motion.cornering),
    },
    servo: {
      upPercent: pct(p.servo?.upPercent, base.servo.upPercent),
      downPercent: pct(p.servo?.downPercent, base.servo.downPercent),
      liftMs: Math.max(0, num(p.servo?.liftMs, base.servo.liftMs)),
      dropMs: Math.max(0, num(p.servo?.dropMs, base.servo.dropMs)),
    },
    pens,
    units: 'mm',
  }
}

function sanitizeGrblProfile(p: Record<string, any>): MachineProfile {
  const base = GRBL_PLOTTER
  const pens = Array.isArray(p.pens) && p.pens.length ? p.pens.map(sanitizePen) : structuredClone(base.pens)
  // Pen actuation union, coerced on `mode`. An unknown/absent mode falls back to the preset's.
  const pen =
    isObj(p.pen) && p.pen.mode === 'z'
      ? {
          mode: 'z' as const,
          up: num(p.pen.up, 5),
          down: num(p.pen.down, 0),
          ...(typeof p.pen.downLight === 'number' && Number.isFinite(p.pen.downLight)
            ? { downLight: p.pen.downLight }
            : {}),
        }
      : isObj(p.pen) && p.pen.mode === 'servo'
        ? {
            mode: 'servo' as const,
            upS: num(p.pen.upS, 750),
            downS: num(p.pen.downS, 250),
            raiseMs: Math.max(0, num(p.pen.raiseMs, 300)),
            lowerMs: Math.max(0, num(p.pen.lowerMs, 300)),
          }
        : structuredClone(base.pen)
  return {
    id: str(p.id, base.id),
    name: str(p.name, base.name),
    kind: 'grbl',
    ...(isObj(p.device) && p.device.transport === 'webserial' ? { device: { transport: 'webserial' as const } } : {}),
    bed: { width: num(p.bed?.width, base.bed.width), height: num(p.bed?.height, base.bed.height) },
    origin: p.origin === 'top-left' || p.origin === 'bottom-left' ? p.origin : base.origin,
    baudRate: num(p.baudRate, base.baudRate),
    feeds: { travel: num(p.feeds?.travel, base.feeds.travel), draw: num(p.feeds?.draw, base.feeds.draw) },
    pen,
    homing: p.homing === true,
    pens,
    preamble: str(p.preamble, base.preamble),
    postamble: str(p.postamble, base.postamble),
    pause: str(p.pause, base.pause),
    units: 'mm',
  }
}

/** Coerce an array into valid DocElements. Unknown element types (e.g. from a newer app) are dropped
 *  with a warning; element params are sanitized by the type's own registered sanitizer. */
export function sanitizeElements(arr: unknown): DocElement[] {
  if (!Array.isArray(arr)) return []
  const out: DocElement[] = []
  for (const e of arr) {
    if (!isObj(e)) continue
    const type = str(e.type, '')
    if (!isKnownType(type)) {
      console.warn(`[kg] dropping element of unknown type "${type}"`)
      continue
    }
    // Pen is a top-level element property. Older docs stored it inside `params.pen` (now removed
    // from shape params) — lift it up so those documents keep their pen assignment.
    const legacyPen = isObj(e.params) ? e.params.pen : undefined
    out.push({
      id: str(e.id, crypto.randomUUID()),
      type,
      transform: sanitizeTransform(e.transform),
      params: sanitizeParams(type, e.params),
      pen: num(e.pen, num(legacyPen, 0)),
      ...(typeof e.name === 'string' ? { name: e.name } : {}),
      ...(isObj(e.dash) && typeof e.dash.dash === 'number' && typeof e.dash.gap === 'number'
        ? { dash: { dash: Math.max(0, e.dash.dash), gap: Math.max(0, e.dash.gap) } }
        : {}),
      ...(typeof e.parent === 'string' ? { parent: e.parent } : {}),
      ...(e.clipRole === 'mask' ? { clipRole: 'mask' as const } : {}),
      ...(e.hidden === true ? { hidden: true as const } : {}),
      ...(Array.isArray(e.effects) && e.effects.length ? { effects: sanitizeEffects(e.effects) } : {}),
      // Pressure is optional (absent = full); keep it only when a valid 0..1 value is stored.
      ...(typeof e.pressure === 'number' && Number.isFinite(e.pressure)
        ? { pressure: Math.min(1, Math.max(0, e.pressure)) }
        : {}),
    })
  }
  return out
}

/** A fiducial is a finite {x,y} point, or null. Absent (older docs) → null. */
function sanitizeFiducial(f: unknown): Fiducial | null {
  if (!isObj(f)) return null
  if (typeof f.x !== 'number' || typeof f.y !== 'number' || !Number.isFinite(f.x) || !Number.isFinite(f.y))
    return null
  return { x: f.x, y: f.y }
}

export function sanitizeSnapshot(raw: unknown): DocSnapshot {
  const o = isObj(raw) ? raw : {}
  let elements = sanitizeElements(o.elements)
  // Reconcile containers (group/clip): drop a `parent`/`clipRole` whose container element is gone,
  // then drop any container left with no members — so the pipeline never skips an orphaned member or
  // renders an empty container.
  const containerIds = new Set(elements.filter((e) => isContainer(e.type)).map((e) => e.id))
  for (const e of elements)
    if (e.parent && !containerIds.has(e.parent)) {
      delete e.parent
      delete e.clipRole
    }
  const containersWithMembers = new Set<string>()
  for (const e of elements) if (e.parent) containersWithMembers.add(e.parent)
  elements = elements.filter((e) => !isContainer(e.type) || containersWithMembers.has(e.id))
  const ids = new Set(elements.map((e) => e.id))
  // Back-compat: a pre-multi-select doc stored a single `selectedId`.
  const rawIds = Array.isArray(o.selectedIds)
    ? o.selectedIds
    : typeof o.selectedId === 'string'
      ? [o.selectedId]
      : []
  const selectedIds = rawIds.filter((id: unknown): id is string => typeof id === 'string' && ids.has(id))

  return { elements, profile: sanitizeProfile(o.profile), selectedIds, fiducial: sanitizeFiducial(o.fiducial) }
}

// ---- migrations ---------------------------------------------------------------------------------
// Map each version N to a function bumping a vN blob to v(N+1). Empty today; add entries as the
// schema evolves and the data shape changes in a non-backfillable way.
type Migrator = (raw: any) => any
const docMigrations: Record<number, Migrator> = {}
const libraryMigrations: Record<number, Migrator> = {}

function applyMigrations(raw: any, from: number, to: number, table: Record<number, Migrator>): any {
  let cur = raw
  for (let v = from; v < to; v++) {
    const step = table[v]
    if (!step) break // no transform needed for this step; sanitizers will backfill
    cur = step(cur)
  }
  return cur
}

// ---- document load ------------------------------------------------------------------------------

/** Parse a stored/again-imported document object into a `StoredDoc`. Total — never throws. */
export function loadStoredDoc(raw: unknown): Outcome<StoredDoc> {
  try {
    if (!isObj(raw)) return { status: 'invalid', message: 'not an object' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_DOC_SCHEMA)
      return { status: 'unsupported', message: `document schema v${v} (supported: v${CURRENT_DOC_SCHEMA})` }
    const migrated = applyMigrations(raw, v, CURRENT_DOC_SCHEMA, docMigrations)
    const snap = sanitizeSnapshot(migrated)
    return {
      status: 'ok',
      value: {
        schemaVersion: CURRENT_DOC_SCHEMA,
        id: str(migrated.id, crypto.randomUUID()),
        name: str(migrated.name, ''),
        updatedAt: num(migrated.updatedAt, 0),
        ...snap,
      },
    }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}

/** Serialize a document for storage / round-trip. */
export function serializeDoc(d: StoredDoc): StoredDoc {
  return { ...d, schemaVersion: CURRENT_DOC_SCHEMA }
}

// ---- library load -------------------------------------------------------------------------------

export interface StoredLibrary {
  schemaVersion: number
  profiles: MachineProfile[]
}

export function loadStoredLibrary(raw: unknown): Outcome<MachineProfile[]> {
  try {
    if (!isObj(raw)) return { status: 'invalid', message: 'not an object' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_LIBRARY_SCHEMA)
      return { status: 'unsupported', message: `library schema v${v} (supported: v${CURRENT_LIBRARY_SCHEMA})` }
    const migrated = applyMigrations(raw, v, CURRENT_LIBRARY_SCHEMA, libraryMigrations)
    const profiles = Array.isArray(migrated.profiles) ? migrated.profiles.map(sanitizeProfile) : []
    return { status: 'ok', value: profiles }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}

// ---- custom-tool library load -------------------------------------------------------------------

/** A saved Logo program that appears as a tool in the sidebar (see store/logoTools.ts). The source
 *  is a snapshot — stamped elements are self-contained, never live-linked back to the tool. */
export interface LogoTool {
  id: string
  name: string
  source: string
}

function sanitizeTool(raw: unknown): LogoTool | null {
  if (!isObj(raw)) return null
  const name = str(raw.name, '').trim()
  if (!name || typeof raw.source !== 'string') return null
  return { id: str(raw.id, crypto.randomUUID()), name, source: raw.source }
}

const toolsMigrations: Record<number, Migrator> = {}

function sanitizeTools(raw: unknown): LogoTool[] {
  return Array.isArray(raw) ? raw.map(sanitizeTool).filter((t): t is LogoTool => t !== null) : []
}

export function loadStoredTools(raw: unknown): Outcome<LogoTool[]> {
  try {
    if (!isObj(raw)) return { status: 'invalid', message: 'not an object' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_TOOLS_SCHEMA)
      return { status: 'unsupported', message: `tools schema v${v} (supported: v${CURRENT_TOOLS_SCHEMA})` }
    const migrated = applyMigrations(raw, v, CURRENT_TOOLS_SCHEMA, toolsMigrations)
    return { status: 'ok', value: sanitizeTools(migrated.tools) }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}

// ---- file (import/export) envelopes -------------------------------------------------------------

export function documentFile(doc: StoredDoc) {
  return {
    kind: DOC_FILE_KIND,
    schemaVersion: CURRENT_DOC_SCHEMA,
    document: {
      name: doc.name,
      elements: doc.elements,
      profile: doc.profile,
      selectedIds: doc.selectedIds,
      fiducial: doc.fiducial,
    },
  }
}

export function profilesFile(profiles: MachineProfile[]) {
  return { kind: PROFILES_FILE_KIND, schemaVersion: CURRENT_LIBRARY_SCHEMA, profiles }
}

export function toolsFile(tools: LogoTool[]) {
  return { kind: TOOLS_FILE_KIND, schemaVersion: CURRENT_TOOLS_SCHEMA, tools }
}

/** Parse an imported tools file → tool array. Total. */
export function parseToolsFile(raw: unknown): Outcome<LogoTool[]> {
  try {
    if (!isObj(raw) || raw.kind !== TOOLS_FILE_KIND)
      return { status: 'invalid', message: 'not a Kurvengefahr tools file' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_TOOLS_SCHEMA) return { status: 'unsupported', message: `tools file schema v${v}` }
    const migrated = applyMigrations(raw, v, CURRENT_TOOLS_SCHEMA, toolsMigrations)
    return { status: 'ok', value: sanitizeTools(migrated.tools) }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}

/** Parse an imported document file → snapshot + name. Total. */
export function parseDocumentFile(raw: unknown): Outcome<{ name: string; snapshot: DocSnapshot }> {
  try {
    if (!isObj(raw) || raw.kind !== DOC_FILE_KIND)
      return { status: 'invalid', message: 'not a Kurvengefahr document file' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_DOC_SCHEMA)
      return { status: 'unsupported', message: `document file schema v${v}` }
    const migrated = applyMigrations(raw.document, v, CURRENT_DOC_SCHEMA, docMigrations)
    return { status: 'ok', value: { name: str(raw.document?.name, ''), snapshot: sanitizeSnapshot(migrated) } }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}

/** Parse an imported profiles file → profile array. Total. */
export function parseProfilesFile(raw: unknown): Outcome<MachineProfile[]> {
  try {
    if (!isObj(raw) || raw.kind !== PROFILES_FILE_KIND)
      return { status: 'invalid', message: 'not a Kurvengefahr profiles file' }
    const v = num(raw.schemaVersion, 1)
    if (v > CURRENT_LIBRARY_SCHEMA)
      return { status: 'unsupported', message: `profiles file schema v${v}` }
    const migrated = applyMigrations(raw, v, CURRENT_LIBRARY_SCHEMA, libraryMigrations)
    const profiles = Array.isArray(migrated.profiles) ? migrated.profiles.map(sanitizeProfile) : []
    return { status: 'ok', value: profiles }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}
