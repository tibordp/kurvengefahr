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

/** Memoized local-mm geometry for an element. Sync types compute on miss; async types return the
 *  cached/stale/empty geometry and rely on the generation controller to fill the cache. */
export function generateLocal(el: DocElement): Geometry {
  const hash = hashParams(el.params)
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
