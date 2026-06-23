// Flatten the `Stroke[]` IR into a CSR-style set of typed arrays for the WASM boundary,
// and rebuild it on the way back. This flat representation — not serde'd objects — is the
// boundary contract we commit to early because it is the expensive thing to change later.
//
//   xy:         Float32Array, interleaved [x0,y0, x1,y1, ...]  (one pair per point)
//   pressure:   Float32Array, one value per point (parallel to xy pairs)
//   offsets:    Uint32Array, length nStrokes+1, point index where each stroke starts (CSR)
//   pen:        Uint16Array, length nStrokes
//   reversible: Uint8Array,  length nStrokes (0/1)
//   group:      Uint32Array, length nStrokes (chain id; 0 = free singleton)
import type { Geometry } from '../types'

export interface FlatGeometry {
  xy: Float32Array
  pressure: Float32Array
  offsets: Uint32Array
  pen: Uint16Array
  reversible: Uint8Array
  group: Uint32Array
}

const DEFAULT_PRESSURE = 1

export function flatten(geom: Geometry): FlatGeometry {
  let nPoints = 0
  for (const s of geom) nPoints += s.points.length

  const xy = new Float32Array(nPoints * 2)
  const pressure = new Float32Array(nPoints)
  const offsets = new Uint32Array(geom.length + 1)
  const pen = new Uint16Array(geom.length)
  const reversible = new Uint8Array(geom.length)
  const group = new Uint32Array(geom.length)

  let p = 0
  for (let i = 0; i < geom.length; i++) {
    const s = geom[i]
    offsets[i] = p
    pen[i] = s.pen
    reversible[i] = s.reversible ? 1 : 0
    group[i] = s.group ?? 0
    for (const pt of s.points) {
      xy[p * 2] = pt.x
      xy[p * 2 + 1] = pt.y
      pressure[p] = pt.pressure ?? DEFAULT_PRESSURE
      p++
    }
  }
  offsets[geom.length] = p
  return { xy, pressure, offsets, pen, reversible, group }
}

export function unflatten(flat: FlatGeometry): Geometry {
  const { xy, pressure, offsets, pen, reversible, group } = flat
  const geom: Geometry = []
  const nStrokes = pen.length
  for (let i = 0; i < nStrokes; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    const points = []
    for (let p = start; p < end; p++) {
      points.push({ x: xy[p * 2], y: xy[p * 2 + 1], pressure: pressure[p] })
    }
    const stroke: Geometry[number] = { points, pen: pen[i], reversible: reversible[i] !== 0 }
    if (group[i] !== 0) stroke.group = group[i]
    geom.push(stroke)
  }
  return geom
}
