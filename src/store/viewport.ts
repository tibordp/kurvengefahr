// Canvas view state, separate from the document: the pan/zoom viewport and the live cursor
// position. Both are transient UI state. Keeping the cursor in its own store means the status
// bar re-renders on mouse-move without dragging the Stage subtree along with it.
import { create } from 'zustand'

interface ViewportStore {
  /** Pixels per millimetre (zoom). */
  scale: number
  /** Layer offset in px (pan). */
  x: number
  y: number
  /** The scale at which the bed fits the viewport — basis for the zoom % readout. */
  fit: number
  setViewport: (v: { scale: number; x: number; y: number }) => void
  setFit: (fit: number) => void
}

export const useViewport = create<ViewportStore>((set) => ({
  scale: 1,
  x: 0,
  y: 0,
  fit: 1,
  setViewport: (v) => set(v),
  setFit: (fit) => set({ fit }),
}))

interface CursorStore {
  /** Cursor position in bed millimetres. */
  x: number
  y: number
  /** Whether the cursor is over the bed. */
  inside: boolean
  setCursor: (x: number, y: number, inside: boolean) => void
  clear: () => void
}

export const useCursor = create<CursorStore>((set) => ({
  x: 0,
  y: 0,
  inside: false,
  setCursor: (x, y, inside) => set({ x, y, inside }),
  clear: () => set({ inside: false }),
}))
