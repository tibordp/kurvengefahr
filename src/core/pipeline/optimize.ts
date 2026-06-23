// Stage: stroke ordering to minimise pen-up travel. Backed by the Rust/WASM crate.
// v1 is greedy nearest-neighbour honouring `reversible`; the seam is here for the
// Z-aware lift-minimizer later. Operates in page mm; geometry is never altered, only
// reordered (and reversible strokes possibly flipped).
import type { Geometry } from '../types'
import { initWasm, optimize as wasmOptimize } from '../wasm'
import { flatten, unflatten } from '../wasm/serde'

export async function optimizeGeometry(
  geom: Geometry,
  start: { x: number; y: number } = { x: 0, y: 0 },
): Promise<Geometry> {
  if (geom.length === 0) return geom
  await initWasm()

  const flat = flatten(geom)
  const result = wasmOptimize(
    flat.xy,
    flat.pressure,
    flat.offsets,
    flat.pen,
    flat.reversible,
    flat.group,
    start.x,
    start.y,
  )
  // Copy the typed arrays out before freeing the Rust-owned struct.
  const out = unflatten({
    xy: result.xy,
    pressure: result.pressure,
    offsets: result.offsets,
    pen: result.pen,
    reversible: result.reversible,
    group: result.group,
  })
  result.free()
  return out
}
