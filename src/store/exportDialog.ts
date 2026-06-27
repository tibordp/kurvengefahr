// Whether the Export dialog (format + options) is open. View state only.
import { create } from 'zustand'

interface Store {
  open: boolean
  set: (open: boolean) => void
}

export const useExportDialog = create<Store>((set) => ({ open: false, set: (open) => set({ open }) }))
