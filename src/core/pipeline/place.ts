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

/** Element-local (x,y) → page (x,y). For the on-canvas node-editing overlay. */
export function localToPage(t: Transform, x: number, y: number): { x: number; y: number } {
  const m = transformToMatrix(t)
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/** Page (x,y) → element-local (x,y) (inverse affine). */
export function pageToLocal(t: Transform, x: number, y: number): { x: number; y: number } {
  const m = transformToMatrix(t)
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 }
  const dx = x - m[4]
  const dy = y - m[5]
  return { x: (m[3] * dx - m[2] * dy) / det, y: (-m[1] * dx + m[0] * dy) / det }
}

/** Lift an element's local geometry into page space. */
export function place(geom: Geometry, t: Transform): Geometry {
  const m = transformToMatrix(t)
  return geom.map((s) => placeStroke(s, m))
}
