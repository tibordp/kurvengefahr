// Grid snapping for the canvas (view-coupled, like the drawing interaction). Snaps a page-mm point
// to the grid when grid-snap is on; Alt bypasses. (Object/point snapping was removed — the pen's
// snap-to-start close behaviour lives in drawing.ts, independent of this.)
import { useSnap } from '../store/snap'
import type { Pt } from './drawing'

export function snap(p: Pt, bypass = false): Pt {
  const s = useSnap.getState()
  if (bypass || !s.grid || s.gridSize <= 0) return p
  const g = s.gridSize
  return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g }
}
