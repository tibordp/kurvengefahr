// Pure viewport math: fitting the bed, and clamping pan/zoom so the bed can't be lost.
// The rule the user asked for: if the (scaled) bed fits the viewport on an axis, that axis is
// locked centered — no panning; if it's larger, panning is allowed but clamped to the edges.

export const MIN_SCALE = 0.5 // px/mm
export const MAX_SCALE = 60

export interface Viewport {
  scale: number
  x: number
  y: number
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Scale at which the bed fits the viewport with a margin. */
export function fitScale(
  vw: number,
  vh: number,
  bedW: number,
  bedH: number,
  margin = 24,
): number {
  if (vw <= 0 || vh <= 0) return 1
  return Math.max(
    MIN_SCALE,
    Math.min((vw - 2 * margin) / bedW, (vh - 2 * margin) / bedH),
  )
}

/** Clamp scale to limits, then center-or-clamp each axis per the fits-in-viewport rule. */
export function clampViewport(
  vp: Viewport,
  vw: number,
  vh: number,
  bedW: number,
  bedH: number,
): Viewport {
  const scale = clamp(vp.scale, MIN_SCALE, MAX_SCALE)
  const cw = bedW * scale
  const ch = bedH * scale
  const x = cw <= vw ? (vw - cw) / 2 : clamp(vp.x, vw - cw, 0)
  const y = ch <= vh ? (vh - ch) / 2 : clamp(vp.y, vh - ch, 0)
  return { scale, x, y }
}
