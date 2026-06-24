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
import { PRUSA_MK4 } from '../profiles'
import { isKnownType, sanitizeParams } from '../../elements/registry'

export const CURRENT_DOC_SCHEMA = 1
export const CURRENT_LIBRARY_SCHEMA = 1

export const DOC_FILE_KIND = 'kurvengefahr/document'
export const PROFILES_FILE_KIND = 'kurvengefahr/profiles'

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

/** Coerce any object into a valid MachineProfile, backfilling from PRUSA_MK4 so fields added in a
 *  later schema are present even when loading an older profile. Exported for the library + imports. */
export function sanitizeProfile(p: unknown): MachineProfile {
  const base = PRUSA_MK4
  if (!isObj(p)) return structuredClone(base)
  const pens = Array.isArray(p.pens) && p.pens.length ? p.pens.map(sanitizePen) : structuredClone(base.pens)
  return {
    id: str(p.id, base.id),
    name: str(p.name, base.name),
    bed: { width: num(p.bed?.width, base.bed.width), height: num(p.bed?.height, base.bed.height) },
    origin: p.origin === 'top-left' || p.origin === 'bottom-left' ? p.origin : base.origin,
    feeds: { travel: num(p.feeds?.travel, base.feeds.travel), draw: num(p.feeds?.draw, base.feeds.draw) },
    penZ: {
      up: num(p.penZ?.up, base.penZ.up),
      down: num(p.penZ?.down, base.penZ.down),
      dwell: num(p.penZ?.dwell, base.penZ.dwell),
    },
    penOffset: { x: num(p.penOffset?.x, 0), y: num(p.penOffset?.y, 0), z: num(p.penOffset?.z, 0) },
    pens,
    preamble: str(p.preamble, base.preamble),
    postamble: str(p.postamble, base.postamble),
    pause: str(p.pause, base.pause),
    units: 'mm',
  }
}

/** Coerce an array into valid DocElements. Unknown element types (e.g. from a newer app) are dropped
 *  with a warning; element params are sanitized by the type's own registered sanitizer. */
function sanitizeElements(arr: unknown): DocElement[] {
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
  const elements = sanitizeElements(o.elements)
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
