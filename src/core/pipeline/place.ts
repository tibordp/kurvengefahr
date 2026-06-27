// Stage: element-local mm → page mm, via the element's affine transform.
// Cheap reparametrization — changing a transform invalidates only this, never `generate()`.
import type { DocElement, Geometry, Point, Stroke, Transform } from '../types'

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

/** Compose two affines: the result applies `b` first, then `a` (a·b). */
export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

/** Decompose an affine back into translate·rotate·scale (drops any shear — exact for
 *  translate/rotate/uniform-scale, the common case). Inverse of {@link transformToMatrix}. */
export function matrixToTransform(m: Matrix): Transform {
  const [a, b, c, d, e, f] = m
  const scaleX = Math.hypot(a, b)
  const det = a * d - b * c
  const scaleY = scaleX > 1e-9 ? det / scaleX : Math.hypot(c, d)
  return { x: e, y: f, rotation: (Math.atan2(b, a) * 180) / Math.PI, scaleX, scaleY }
}

/** Bake a parent transform onto a child (parent ∘ child) as one decomposed transform. */
export function composeTransforms(parent: Transform, child: Transform): Transform {
  return matrixToTransform(multiplyMatrix(transformToMatrix(parent), transformToMatrix(child)))
}

function invertMatrix(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0]
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det
  return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)]
}

/** The inverse of a transform (as a decomposed transform). */
export function invertTransform(t: Transform): Transform {
  return matrixToTransform(invertMatrix(transformToMatrix(t)))
}

/** A clip member's transform is relative to its clip's local space; compose up the `clipParent`
 *  chain to get its true page transform (so it can be rendered/edited in place). */
export function effectiveTransform(el: DocElement, byId: Map<string, DocElement>): Transform {
  let t = el.transform
  let pid = el.clipParent
  const seen = new Set<string>()
  while (pid && !seen.has(pid)) {
    seen.add(pid)
    const clip = byId.get(pid)
    if (!clip) break
    t = composeTransforms(clip.transform, t)
    pid = clip.clipParent
  }
  return t
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
