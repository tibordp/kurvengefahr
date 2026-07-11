// Whether the Share dialog is open. View state only.
import { create } from 'zustand'

interface Store {
  open: boolean
  set: (open: boolean) => void
}

export const useShareDialog = create<Store>((set) => ({ open: false, set: (open) => set({ open }) }))
