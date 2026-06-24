// Synchronous TS wrappers over the Rust shape-tessellation exports. Like `clip`, these run on the
// main thread (WASM is initialized before first render), so element `generate()` can call them
// directly. Each decodes the returned GeometryBuffers and frees the Rust-owned struct.
import {
  tessellate_rect,
  tessellate_ellipse,
  tessellate_path,
  simplify_polyline,
  hatch,
  concentric,
  GeometryBuffers,
} from './index'
import { unflatten } from './serde'
import type { Geometry } from '../types'

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

/** `nodes` is 6 floats per node: [x, y, hinX, hinY, houtX, houtY] (handles relative to anchor). */
export function pathGeometry(nodes: Float32Array, closed: boolean, tol = 0): Geometry {
  return decode(tessellate_path(nodes, closed, tol))
}

/** RDP-simplify a flat [x0,y0,…] polyline; returns the kept points, flat. */
export function simplifyPolyline(xy: Float32Array, tol: number): Float32Array {
  return simplify_polyline(xy, tol)
}

/** Hatch fill for a closed-polygon outline. pattern: 0 lines, 1 cross, 2 grid, 3 hilbert. */
export function hatchGeometry(
  polygonXy: Float32Array,
  pattern: number,
  spacing: number,
  angleDeg: number,
): Geometry {
  return decode(hatch(polygonXy, pattern, spacing, angleDeg))
}

/** Concentric rings. kind 0 = rect (a=w, b=h); kind 1 = ellipse (a=rx, b=ry). */
export function concentricGeometry(kind: number, a: number, b: number, spacing: number): Geometry {
  return decode(concentric(kind, a, b, spacing))
}
