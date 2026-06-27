// Holds the DXF bytes picked for import while the options dialog is open. importFile sets it after
// the file picker; the dialog reads it. Cleared on import/cancel. View state only.
import { create } from 'zustand'

export interface PendingDxf {
  bytes: Uint8Array
  name: string
}

interface Store {
  pending: PendingDxf | null
  open: (p: PendingDxf) => void
  close: () => void
}

export const useDxfImport = create<Store>((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}))
