// Element type registry + per-element memoization of local geometry.
//
// Each element type either generates **synchronously** (a pure `generate(params) → Geometry`, for
// cheap/future element types) or **asynchronously** (handwriting: the model runs in a Web Worker —
// see core/generation.ts). We memoize local-mm geometry on a stable hash of the geometry-affecting
// params, keyed by element id, so the expensive step only re-runs when params actually change.
//
// For async types `generateLocal` never computes; it returns the cached geometry, or — while a
// regeneration is in flight — the last known (stale) geometry, or `[]` if nothing exists yet. The
// generation controller fills the cache via `markGenerated` and triggers a re-render.
import type { DocElement, Geometry } from '../core/types'

export type Generator = (params: any) => Geometry

/** Whether this element's strokes should form one locked, ordered chain (vs. go in the global
 *  optimization bag). Decided per element from its params. */
export type LockPredicate = (params: any) => boolean

interface ElementType {
  /** Synchronous generator, or undefined for async (worker-backed) types. */
  generate?: Generator
  isLocked?: LockPredicate
  /** Coerce arbitrary (persisted/imported) params into a valid shape, filling defaults. Used by
   *  persistence so a malformed or older params object can't crash the inspector or generator. */
  sanitizeParams?: (raw: unknown) => unknown
  /** Bake a scale factor into the params (returning new params), so the Konva Transformer's resize
   *  edits real dimensions instead of leaving a residual transform scale. Types without this keep
   *  the scale in their transform (e.g. handwriting scales its ink). */
  applyScale?: (params: any, sx: number, sy: number) => unknown
  /** Natively multi-colour: the generator assigns per-stroke `pen`s itself, so concatenation must
   *  NOT stamp the element's single `pen` over them. None today; the seam is here so adding such a
   *  type (e.g. a multi-layer SVG import) needs no pipeline change. */
  multiPen?: boolean
  /** Async types only: when this returns true, param edits trigger a **debounced auto-regenerate**
   *  (live preview) instead of waiting for a manual "Regenerate". Decided per-params so a type can
   *  be live in a cheap mode and manual in a heavy one. Absent / false = manual (the default, e.g.
   *  handwriting — its model run is too slow to fire on every keystroke). */
  autoRegenerate?: (params: any) => boolean
  /** Async + bakes-scale types: the local-mm box the geometry is fit into. After a resize bakes a
   *  new box into params, the stale (still-old-sized) ink is provisionally rescaled by
   *  new-box / generated-box until the re-trace lands — so it tracks the handles instead of
   *  flashing the old size. Absent → no provisional rescale. */
  provisionalExtent?: (params: any) => { w: number; h: number } | null
  /** Param keys that are display-only (don't affect the generated geometry), e.g. a per-element
   *  "show source image" toggle. Excluded from the geometry hash so flipping them never marks the
   *  element dirty or triggers a regenerate. */
  viewParams?: string[]
}

const types = new Map<string, ElementType>()

export function registerElement(type: string, def: ElementType): void {
  types.set(type, def)
}

/** Whether a type has been registered. Persistence uses this to drop unknown element types safely
 *  (e.g. a document written by a newer app version that added an element type we don't have). */
export function isKnownType(type: string): boolean {
  return types.has(type)
}

/** Coerce persisted/imported params for a type into a valid shape (no-op if the type registers no
 *  sanitizer). */
export function sanitizeParams(type: string, raw: unknown): unknown {
  return types.get(type)?.sanitizeParams?.(raw) ?? raw
}

/** Whether this type bakes transform-scale into its params (vs keeping it in the transform). */
export function bakesScale(type: string): boolean {
  return !!types.get(type)?.applyScale
}

/** Whether this type assigns per-stroke pens itself (so concatenation leaves its pens untouched). */
export function isMultiPen(type: string): boolean {
  return !!types.get(type)?.multiPen
}

/** Whether edits to this element should auto-regenerate (debounced) rather than wait for a manual
 *  "Regenerate". Params-dependent so a type can be live in a cheap mode and manual in a heavy one. */
export function isAutoRegenerate(type: string, params: unknown): boolean {
  return !!types.get(type)?.autoRegenerate?.(params)
}

/** The local-mm box geometry is fit into for these params (for provisional rescale of stale ink
 *  after a resize), or null if the type doesn't bake size into a box. */
export function getProvisionalExtent(type: string, params: unknown): { w: number; h: number } | null {
  return types.get(type)?.provisionalExtent?.(params) ?? null
}

/** Bake a scale into a type's params (no-op if the type doesn't support it). */
export function applyScale(type: string, params: unknown, sx: number, sy: number): unknown {
  const def = types.get(type)
  return def?.applyScale ? def.applyScale(params, sx, sy) : params
}

/** Element types without a predicate are never locked — their strokes always go in the bag. */
export function isElementLocked(type: string, params: unknown): boolean {
  return types.get(type)?.isLocked?.(params) ?? false
}

/** Whether a type generates asynchronously (no synchronous generator). */
export function isAsyncType(type: string): boolean {
  const def = types.get(type)
  return !!def && !def.generate
}

interface CacheEntry {
  hash: string
  geom: Geometry
}
const cache = new Map<string, CacheEntry>()

/** Stable hash of params: object keys are sorted recursively so key order never matters. */
export function hashParams(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(hashParams).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${hashParams((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

/** Hash of only the geometry-affecting params (display-only `viewParams` stripped), so toggling a
 *  view param doesn't invalidate the memo or mark the element dirty. The single source of truth for
 *  "did the geometry inputs change". */
export function geometryHash(type: string, params: unknown): string {
  const viewKeys = types.get(type)?.viewParams
  if (viewKeys && viewKeys.length && params && typeof params === 'object' && !Array.isArray(params)) {
    const stripped = { ...(params as Record<string, unknown>) }
    for (const k of viewKeys) delete stripped[k]
    return hashParams(stripped)
  }
  return hashParams(params)
}

/** Memoized local-mm geometry for an element. Sync types compute on miss; async types return the
 *  cached/stale/empty geometry and rely on the generation controller to fill the cache. */
export function generateLocal(el: DocElement): Geometry {
  const hash = geometryHash(el.type, el.params)
  const hit = cache.get(el.id)
  if (hit && hit.hash === hash) return hit.geom

  const def = types.get(el.type)
  if (!def) throw new Error(`No element type registered for "${el.type}"`)

  if (!def.generate) {
    // Async type: show the last known ink (if any) until the worker delivers the new geometry.
    return hit?.geom ?? []
  }
  const geom = def.generate(el.params)
  cache.set(el.id, { hash, geom })
  return geom
}

/** Cache entry for an element (hash + geometry), or undefined. Used by the generation controller
 *  to decide whether a regeneration is needed. */
export function getCached(id: string): Readonly<CacheEntry> | undefined {
  return cache.get(id)
}

/** Store worker-produced geometry for an async element. */
export function markGenerated(id: string, hash: string, geom: Geometry): void {
  cache.set(id, { hash, geom })
}

export function dropFromCache(id: string): void {
  cache.delete(id)
}
