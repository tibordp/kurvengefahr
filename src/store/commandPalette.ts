// Whether the command palette (⌘/Ctrl+K) is open. View state only.
import { create } from 'zustand'

interface Store {
  open: boolean
  set: (open: boolean) => void
  toggle: () => void
}

export const useCommandPalette = create<Store>((set) => ({
  open: false,
  set: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
