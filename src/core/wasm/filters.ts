// Thin wrapper over the Rust filter stack (crate/src/filters). Flatten → call → unflatten → free,
// like clip/optimize. The filter param *union* crosses as one JSON string (the raster precedent),
// so adding a filter never changes this signature. Synchronous — main-thread WASM is ready before
// first render.
import type { FilterSpec, Geometry } from '../types'
import { apply_filters } from '.'
import { flatten, unflatten } from './serde'

/** Apply a filter stack to local-space geometry. Returns the input unchanged when there's nothing
 *  to do (caller should skip when no enabled filters). */
export function applyFiltersWasm(geom: Geometry, filters: FilterSpec[]): Geometry {
  if (geom.length === 0 || filters.length === 0) return geom
  const flat = flatten(geom)
  const res = apply_filters(
    flat.xy,
    flat.pressure,
    flat.offsets,
    flat.pen,
    flat.reversible,
    flat.group,
    JSON.stringify(filters),
  )
  const out = unflatten({
    xy: res.xy,
    pressure: res.pressure,
    offsets: res.offsets,
    pen: res.pen,
    reversible: res.reversible,
    group: res.group,
  })
  res.free()
  return out
}
