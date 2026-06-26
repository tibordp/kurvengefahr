// Which element the pointer is hovering in the Elements tree, so the canvas can highlight it.
// View state only — never persisted, not an undo step.
import { create } from 'zustand'

interface Store {
  id: string | null
  set: (id: string | null) => void
}

export const useHover = create<Store>((set) => ({ id: null, set: (id) => set({ id }) }))
