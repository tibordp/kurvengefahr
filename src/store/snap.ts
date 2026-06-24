// Grid snapping settings (transient UI state, like viewport). Snaps drawing, dragging, and resizing
// to a grid; hold Alt to bypass. See canvas/snap.ts.
import { create } from 'zustand'

interface SnapStore {
  grid: boolean
  /** Grid step in mm. */
  gridSize: number
  setGrid: (b: boolean) => void
  setGridSize: (n: number) => void
}

export const useSnap = create<SnapStore>((set) => ({
  grid: true,
  gridSize: 5,
  setGrid: (grid) => set({ grid }),
  setGridSize: (gridSize) => set({ gridSize: Math.max(0.5, gridSize) }),
}))
