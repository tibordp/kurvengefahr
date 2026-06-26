// Holds the SVG bytes picked for import while the options dialog is open. The dialog reads this;
// DocumentMenu sets it after the file picker. Cleared on import/cancel. View state only.
import { create } from 'zustand'

export interface PendingSvg {
  bytes: Uint8Array
  name: string
}

interface Store {
  pending: PendingSvg | null
  open: (p: PendingSvg) => void
  close: () => void
}

export const useSvgImport = create<Store>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}))
