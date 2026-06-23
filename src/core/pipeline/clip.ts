// Drawable region (computed here — it's view-adjacent) + a thin wrapper over the Rust clipper.
// The pen reaches `bed ∩ (bed + offset)`; the rest of the paper is unreachable. The actual
// polyline clipping/splitting lives in the crate (clip.rs); this just marshals across.
import type { Geometry, MachineProfile } from '../types'
import { clip as wasmClip } from '../wasm'
import { flatten, unflatten } from '../wasm/serde'

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** The reachable drawing rectangle in page coordinates. A nonzero pen offset shifts the pen
 *  relative to the nozzle, so part of the paper becomes unreachable; with origin flips the
 *  unreachable strip lands on the matching page edge. */
export function drawableRegion(profile: MachineProfile): Rect {
  const { bed, penOffset, origin } = profile
  // Machine-space reach: pen target must lie on paper AND map to an in-bounds nozzle.
  const mx0 = Math.max(0, penOffset.x)
  const mx1 = bed.width + Math.min(0, penOffset.x)
  const my0 = Math.max(0, penOffset.y)
  const my1 = bed.height + Math.min(0, penOffset.y)
  // Page space: X is shared; Y flips for a bottom-left origin.
  if (origin === 'bottom-left') {
    return { x0: mx0, y0: bed.height - my1, x1: mx1, y1: bed.height - my0 }
  }
  return { x0: mx0, y0: my0, x1: mx1, y1: my1 }
}

/** Clip geometry to the rect (Rust). Strokes leaving and re-entering are split; pen/reversible/
 *  group are preserved. Synchronous — the WASM module is instantiated before first render. */
export function clipToRegion(geom: Geometry, r: Rect): Geometry {
  if (geom.length === 0) return geom
  const flat = flatten(geom)
  const res = wasmClip(
    flat.xy,
    flat.pressure,
    flat.offsets,
    flat.pen,
    flat.reversible,
    flat.group,
    r.x0,
    r.y0,
    r.x1,
    r.y1,
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
