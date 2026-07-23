// Transient chrome UI state that isn't part of the authoritative document. The mobile inspector
// drawer (on narrow viewports the inspector slides in over the canvas, toggled from the toolbar;
// on desktop it's always docked and the flag is ignored), the Help/About dialog, and the Logo
// code dock (a resizable editor panel under the canvas — see ui/LogoDock.tsx).
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
  /** Logo code dock: the id of the element being edited, or null when closed. Opening is always
   *  explicit (inspector button, canvas double-click, or element creation — never mere selection)
   *  and the session is modal-ish: the canvas mutes everything else while it's set. */
  codeDockFor: string | null
  setCodeDockFor: (id: string | null) => void
  /** Dock height in px (transient — never persisted with the document). */
  codeDockHeight: number
  setCodeDockHeight: (h: number) => void
  /** True while the pointer is over an order-sensitive combine control (clip, boolean subtract):
   *  the canvas then outlines the last-selected element — the mask/cutter that op will act on — so
   *  the button explains its own operand. Purely a hover cue; nothing reads it at click time. */
  operandHint: boolean
  setOperandHint: (on: boolean) => void
}

export const useUI = create<UIStore>((set) => ({
  inspectorOpen: false,
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  setInspectorOpen: (open) => set({ inspectorOpen: open }),
  helpOpen: false,
  toggleHelp: () => set((s) => ({ helpOpen: !s.helpOpen })),
  setHelpOpen: (open) => set({ helpOpen: open }),
  codeDockFor: null,
  setCodeDockFor: (id) => set({ codeDockFor: id }),
  codeDockHeight: 240,
  setCodeDockHeight: (h) => set({ codeDockHeight: h }),
  operandHint: false,
  setOperandHint: (on) => set({ operandHint: on }),
}))
