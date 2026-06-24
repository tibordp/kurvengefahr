// Transient chrome UI state that isn't part of the authoritative document. The mobile inspector
// drawer (on narrow viewports the inspector slides in over the canvas, toggled from the toolbar;
// on desktop it's always docked and the flag is ignored) and the Help/About dialog.
import { create } from 'zustand'

interface UIStore {
  /** Inspector drawer open (only meaningful below the `md` breakpoint). */
  inspectorOpen: boolean
  toggleInspector: () => void
  setInspectorOpen: (open: boolean) => void
  /** Help / About dialog open. */
  helpOpen: boolean
  toggleHelp: () => void
  setHelpOpen: (open: boolean) => void
}

export const useUI = create<UIStore>((set) => ({
  inspectorOpen: false,
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  helpOpen: false,
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
  setHelpOpen: (open) => set({ helpOpen: open }),
}))
