// Drawable region (computed here — it's view-adjacent) + a thin wrapper over the Rust clipper.
// The pen reaches `bed ∩ (bed + offset)`; the rest of the paper is unreachable. The actual
// polyline clipping/splitting lives in the crate (clip.rs); this just marshals across.
import { penOffsetOf, type Geometry, type MachineProfile, type Point } from '../types'
import { clip as wasmClip, clip_polygon as wasmClipPolygon } from '../wasm'
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
  const { bed, origin } = profile
  const penOffset = penOffsetOf(profile)
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

/** Clip geometry to an arbitrary mask polygon — even-odd over `rings` (so nested rings punch holes),
 *  in the same mm space as `geom`. Strokes are split into their inside spans; pen/reversible/group
 *  preserved. Used by clip-to-shape. */
export function clipToPolygon(geom: Geometry, rings: Point[][]): Geometry {
  if (geom.length === 0 || rings.length === 0) return []
  const flat = flatten(geom)
  let n = 0
  for (const r of rings) n += r.length
  const ringXy = new Float32Array(n * 2)
  const ringStarts = new Uint32Array(rings.length + 1)
  let p = 0
  for (let i = 0; i < rings.length; i++) {
    ringStarts[i] = p
    for (const pt of rings[i]) {
      ringXy[p * 2] = pt.x
      ringXy[p * 2 + 1] = pt.y
      p++
    }
  }
  ringStarts[rings.length] = p
  const res = wasmClipPolygon(flat.xy, flat.pressure, flat.offsets, flat.pen, flat.reversible, flat.group, ringXy, ringStarts)
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
