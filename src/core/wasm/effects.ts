// Thin wrapper over the Rust effect stack (crate/src/effects). Flatten → call → unflatten → free,
// like clip/optimize. The effect param *union* crosses as one JSON string (the raster precedent),
// so adding an effect never changes this signature. Synchronous — main-thread WASM is ready before
// first render.
import type { EffectSpec, Geometry } from '../types'
import { apply_effects } from '.'
import { flatten, unflatten } from './serde'

/** Apply an effect stack to local-space geometry. Returns the input unchanged when there's nothing
 *  to do (caller should skip when no enabled effects). */
export function applyEffectsWasm(geom: Geometry, effects: EffectSpec[]): Geometry {
  if (geom.length === 0 || effects.length === 0) return geom
  const flat = flatten(geom)
  const res = apply_effects(
    flat.xy,
    flat.pressure,
    flat.offsets,
    flat.pen,
    flat.reversible,
    flat.group,
    JSON.stringify(effects),
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
