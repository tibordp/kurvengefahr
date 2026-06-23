// Element type registry + per-element memoization of local geometry.
//
// Each element type registers a pure `generate(params) → Geometry` (element-local mm).
// We memoize on a stable hash of the geometry-affecting params, keyed by element id, so the
// expensive step (the RNN, later) only re-runs when params actually change — nudging a
// transform or tweaking a feed never re-generates.
import type { DocElement, Geometry } from '../core/types'

export type Generator = (params: any) => Geometry
/** Whether this element's strokes should form one locked, ordered chain (vs. go in the global
 *  optimization bag). Decided per element from its params. */
export type LockPredicate = (params: any) => boolean

const generators = new Map<string, Generator>()
const lockPredicates = new Map<string, LockPredicate>()

export function registerElement(
  type: string,
  gen: Generator,
  opts?: { isLocked?: LockPredicate },
): void {
  generators.set(type, gen)
  if (opts?.isLocked) lockPredicates.set(type, opts.isLocked)
}

export function getGenerator(type: string): Generator {
  const g = generators.get(type)
  if (!g) throw new Error(`No generator registered for element type "${type}"`)
  return g
}

/** Element types without a predicate are never locked — their strokes always go in the bag. */
export function isElementLocked(type: string, params: unknown): boolean {
  const p = lockPredicates.get(type)
  return p ? p(params) : false
}

interface CacheEntry {
  hash: string
  geom: Geometry
}
const cache = new Map<string, CacheEntry>()

/** Stable hash of params: object keys are sorted recursively so key order never matters. */
function hashParams(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(hashParams).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${hashParams((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

/** Memoized local-mm geometry for an element. */
export function generateLocal(el: DocElement): Geometry {
  const hash = hashParams(el.params)
  const hit = cache.get(el.id)
  if (hit && hit.hash === hash) return hit.geom
  const geom = getGenerator(el.type)(el.params)
  cache.set(el.id, { hash, geom })
  return geom
}

export function dropFromCache(id: string): void {
  cache.delete(id)
}
