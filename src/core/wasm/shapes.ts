// Synchronous TS wrappers over the Rust shape-tessellation exports. Like `clip`, these run on the
// main thread (WASM is initialized before first render), so element `generate()` can call them
// directly. Each decodes the returned GeometryBuffers and frees the Rust-owned struct.
import {
  tessellate_rect,
  tessellate_ellipse,
  tessellate_path,
  simplify_polyline,
  split_cubic,
  hatch,
  concentric,
  boolean,
  import_svg,
  GeometryBuffers,
} from './index'
import { unflatten } from './serde'
import type { Geometry, Point } from '../types'

function decode(res: GeometryBuffers): Geometry {
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

export function rectGeometry(w: number, h: number, cornerRadius = 0): Geometry {
  return decode(tessellate_rect(w, h, cornerRadius))
}

export function ellipseGeometry(rx: number, ry: number): Geometry {
  return decode(tessellate_ellipse(rx, ry))
}

/** Multi-contour path. `nodes` is 6 floats per node ([x, y, hinX, hinY, houtX, houtY], handles
 *  relative to anchor) concatenated across contours; `contourStarts` has `ncontours+1` entries in
 *  node units; `closed[c]` flags contour c. Returns one stroke per contour, in order. */
export function pathGeometry(
  nodes: Float32Array,
  contourStarts: Uint32Array,
  closed: Uint8Array,
  tol = 0,
): Geometry {
  return decode(tessellate_path(nodes, contourStarts, closed, tol))
}

/** RDP-simplify a flat [x0,y0,…] polyline; returns the kept points, flat. */
export function simplifyPolyline(xy: Float32Array, tol: number): Float32Array {
  return simplify_polyline(xy, tol)
}

/** Split the cubic between two path nodes at `t` (de Casteljau), for inserting a node mid-segment.
 *  Anchors absolute; handles relative to their anchor. Returns
 *  `[Sx,Sy, aHoutX,aHoutY, mHinX,mHinY, mHoutX,mHoutY, bHinX,bHinY]`. */
export function splitCubic(
  a: { x: number; y: number },
  aHout: { x: number; y: number },
  bHin: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
): Float32Array {
  return split_cubic(a.x, a.y, aHout.x, aHout.y, bHin.x, bHin.y, b.x, b.y, t)
}

/** Hatch fill for one or more closed-polygon rings (filled together, even-odd → holes). `ringStarts`
 *  has `nrings+1` entries in point units. pattern: 0 lines, 1 cross, 2 grid, 3 hilbert, 4 concentric. */
export function hatchGeometry(
  polygonXy: Float32Array,
  ringStarts: Uint32Array,
  pattern: number,
  spacing: number,
  angleDeg: number,
): Geometry {
  return decode(hatch(polygonXy, ringStarts, pattern, spacing, angleDeg))
}

/** Concentric rings. kind 0 = rect (a=w, b=h); kind 1 = ellipse (a=rx, b=ry). */
export function concentricGeometry(kind: number, a: number, b: number, spacing: number): Geometry {
  return decode(concentric(kind, a, b, spacing))
}

/** One ring set: a flat point buffer + CSR offsets (point units), `nrings+1` entries. */
export interface Rings {
  xy: Float32Array
  starts: Uint32Array
}

/** Boolean op (0 union, 1 intersect, 2 difference, 3 xor) between two multi-contour ring sets.
 *  Returns one stroke per result ring (each a closed contour; outer rings and holes both appear). */
export function booleanGeometry(op: number, subj: Rings, clip: Rings): Geometry {
  return decode(boolean(op, subj.xy, subj.starts, clip.xy, clip.starts))
}

export interface SvgImportRing {
  points: Point[]
  closed: boolean
}
export interface SvgImportShape {
  rings: SvgImportRing[]
  /** Source paint as packed 0xRRGGBB. */
  rgb: number
  /** Fill darkness 0..1 (1 = black); 0 for stroke shapes. */
  darkness: number
  /** 0 = filled region, 1 = stroke centreline. */
  kind: number
}

/** Parse + flatten + (optionally) occlude an SVG into per-shape multi-contour geometry (in mm,
 *  scaled so the longest side is `targetSize`). Geometry only — pen/hatch mapping is done by the
 *  caller. `occlude` subtracts upper filled shapes from those beneath. */
export function importSvgRaw(bytes: Uint8Array, occlude: boolean, targetSize: number): SvgImportShape[] {
  const res = import_svg(bytes, JSON.stringify({ occlude, target_size: targetSize }))
  const xy = res.xy
  const ringStarts = res.ring_starts
  const ringClosed = res.ring_closed
  const shapeStarts = res.shape_starts
  const colors = res.colors
  const darkness = res.darkness
  const kind = res.kind
  const out: SvgImportShape[] = []
  for (let s = 0; s < colors.length; s++) {
    const rings: SvgImportRing[] = []
    for (let r = shapeStarts[s]; r < shapeStarts[s + 1]; r++) {
      const points: Point[] = []
      for (let i = ringStarts[r]; i < ringStarts[r + 1]; i++) points.push({ x: xy[i * 2], y: xy[i * 2 + 1] })
      rings.push({ points, closed: ringClosed[r] !== 0 })
    }
    out.push({ rings, rgb: colors[s], darkness: darkness[s], kind: kind[s] })
  }
  res.free()
  return out
}
