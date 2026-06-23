// Stage: element-local mm → page mm, via the element's affine transform.
// Cheap reparametrization — changing a transform invalidates only this, never `generate()`.
import type { Geometry, Point, Stroke, Transform } from '../types'

/** 2×3 affine as [a, b, c, d, e, f] mapping (x,y) → (a·x + c·y + e, b·x + d·y + f).
 *  Same column convention as CanvasRenderingContext2D / Konva. */
export type Matrix = [number, number, number, number, number, number]

const DEG = Math.PI / 180

/** Compose translate(x,y) · rotate(rotation) · scale(scaleX, scaleY). */
export function transformToMatrix(t: Transform): Matrix {
  const r = t.rotation * DEG
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [
    cos * t.scaleX,
    sin * t.scaleX,
    -sin * t.scaleY,
    cos * t.scaleY,
    t.x,
    t.y,
  ]
}

export function applyMatrix(m: Matrix, p: Point): Point {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
    pressure: p.pressure,
  }
}

function placeStroke(s: Stroke, m: Matrix): Stroke {
  return { ...s, points: s.points.map((p) => applyMatrix(m, p)) }
}

/** Lift an element's local geometry into page space. */
export function place(geom: Geometry, t: Transform): Geometry {
  const m = transformToMatrix(t)
  return geom.map((s) => placeStroke(s, m))
}
