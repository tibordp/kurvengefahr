// Transient chrome UI state that isn't part of the authoritative document. Currently just the
// mobile inspector drawer: on narrow viewports the inspector slides in over the canvas, toggled
// from the toolbar. On desktop the inspector is always docked and this flag is ignored.
import { create } from 'zustand'

interface UIStore {
  /** Inspector drawer open (only meaningful below the `md` breakpoint). */
  inspectorOpen: boolean
  toggleInspector: () => void
  setInspectorOpen: (open: boolean) => void
}

export const useUI = create<UIStore>((set) => ({
  inspectorOpen: false,
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
}))
