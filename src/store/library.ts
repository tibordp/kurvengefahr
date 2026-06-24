// Global library of user-saved machine profiles. Unlike documents, profiles are shared across all
// documents and tabs (they describe your hardware, not your work), so this is a single persisted
// list with last-write-wins cross-tab sync. Built-ins (PROFILE_PRESETS) live in code and are never
// stored here — they only differ in that they can't be deleted/renamed.
import { create } from 'zustand'
import type { MachineProfile } from '../core/types'
import { CURRENT_LIBRARY_SCHEMA, loadStoredLibrary } from './persistence/schema'

const KEY = 'kg-library'

function read(): MachineProfile[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const res = loadStoredLibrary(JSON.parse(raw))
    if (res.status === 'ok') return res.value
    if (res.status === 'unsupported') console.warn(`[kg] profile library: ${res.message}; ignoring`)
    return []
  } catch {
    return []
  }
}

function write(profiles: MachineProfile[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: CURRENT_LIBRARY_SCHEMA, profiles }))
  } catch (e) {
    console.warn('[kg] failed to persist profile library', e)
  }
}

interface LibraryStore {
  customProfiles: MachineProfile[]
  /** Save a profile under a new id+name; returns the created profile (with its id). */
  addProfile: (profile: MachineProfile, name: string) => MachineProfile
  /** Overwrite an existing custom profile (matched by id) with new field values. */
  updateProfile: (id: string, profile: MachineProfile) => void
  removeProfile: (id: string) => void
  renameProfile: (id: string, name: string) => void
  /** Merge imported profiles in, assigning fresh ids (never clobber an existing/built-in id). */
  importProfiles: (profiles: MachineProfile[]) => void
  /** Replace from storage (used by the cross-tab `storage` listener). */
  _hydrate: (profiles: MachineProfile[]) => void
}

const persistAfter =
  (fn: (s: LibraryStore) => Partial<LibraryStore>) =>
  (set: (p: Partial<LibraryStore>) => void, get: () => LibraryStore) => {
    const patch = fn(get())
    if (patch.customProfiles) write(patch.customProfiles)
    set(patch)
  }

export const useLibrary = create<LibraryStore>((set, get) => ({
  customProfiles: read(),

  addProfile: (profile, name) => {
    const created: MachineProfile = { ...structuredClone(profile), id: crypto.randomUUID(), name }
    const customProfiles = [...get().customProfiles, created]
    write(customProfiles)
    set({ customProfiles })
    return created
  },

  updateProfile: (id, profile) =>
    persistAfter((s) => ({
      customProfiles: s.customProfiles.map((p) => (p.id === id ? { ...structuredClone(profile), id, name: p.name } : p)),
    }))(set, get),

  removeProfile: (id) =>
    persistAfter((s) => ({ customProfiles: s.customProfiles.filter((p) => p.id !== id) }))(set, get),

  renameProfile: (id, name) =>
    persistAfter((s) => ({
      customProfiles: s.customProfiles.map((p) => (p.id === id ? { ...p, name } : p)),
    }))(set, get),

  importProfiles: (profiles) =>
    persistAfter((s) => ({
      customProfiles: [
        ...s.customProfiles,
        ...profiles.map((p) => ({ ...p, id: crypto.randomUUID() })),
      ],
    }))(set, get),

  _hydrate: (profiles) => set({ customProfiles: profiles }),
}))

/** Keep tabs in sync: another tab editing the library updates ours (last-write-wins). */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    useLibrary.getState()._hydrate(read())
  })
}
