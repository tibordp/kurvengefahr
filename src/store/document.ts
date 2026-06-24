// The single source of truth: elements + machine profile + selection. The canvas and
// inspector are pure views over this; the canvas library (Konva) never becomes authoritative.
// On a Konva transform-end we read the affine back into here.
import { create } from 'zustand'
import type { DocElement, MachineProfile, Transform } from '../core/types'
import { IDENTITY_TRANSFORM } from '../core/types'
import { dropFromCache } from '../elements/registry'
import { defaultHandwritingParams } from '../elements/handwriting'
import { PRUSA_MK4, findBuiltinProfile } from './profiles'
import { useLibrary } from './library'
import type { DocSnapshot } from './persistence/schema'

let seedCounter = 1

interface DocStore {
  elements: DocElement[]
  profile: MachineProfile
  selectedId: string | null

  addHandwriting: (text?: string) => void
  removeElement: (id: string) => void
  duplicateElement: (id: string) => void
  select: (id: string | null) => void
  /** Replace an element's params wholesale (caller merges). Invalidates Geometry. */
  setParams: (id: string, params: DocElement['params']) => void
  /** Patch an element's transform. Invalidates only Place. */
  setTransform: (id: string, patch: Partial<Transform>) => void
  /** Patch the machine profile. Invalidates only Emit. */
  setProfile: (patch: Partial<MachineProfile>) => void
  /** Adopt a built-in or saved profile as the working profile (a clone — subsequent edits don't
   *  mutate the source until explicitly saved). */
  selectProfile: (id: string) => void
  /** Replace the whole working document (elements + profile + selection). Used by open/new/import
   *  and cross-tab sync. Geometry is recomputed by the generation controller. */
  loadDocument: (snapshot: DocSnapshot) => void
  /** Re-render views over the document without changing element data — used by the generation
   *  controller after async (worker) geometry lands in the cache. */
  notifyGeometry: () => void
}

export const useDoc = create<DocStore>((set) => ({
  elements: [],
  profile: PRUSA_MK4,
  selectedId: null,

  addHandwriting: (text = 'Kurvengefahr') =>
    set((state) => {
      const params = defaultHandwritingParams(text)
      params.style.seed = ++seedCounter
      const el: DocElement = {
        id: crypto.randomUUID(),
        type: 'handwriting',
        transform: { ...IDENTITY_TRANSFORM, x: 20, y: 20 },
        params,
      }
      return { elements: [...state.elements, el], selectedId: el.id }
    }),

  removeElement: (id) =>
    set((state) => {
      dropFromCache(id)
      return {
        elements: state.elements.filter((e) => e.id !== id),
        selectedId: state.selectedId === id ? null : state.selectedId,
      }
    }),

  duplicateElement: (id) =>
    set((state) => {
      const el = state.elements.find((e) => e.id === id)
      if (!el) return {}
      const copy: DocElement = {
        id: crypto.randomUUID(),
        type: el.type,
        transform: { ...el.transform, x: el.transform.x + 5, y: el.transform.y + 5 },
        params: structuredClone(el.params),
      }
      return { elements: [...state.elements, copy], selectedId: copy.id }
    }),

  select: (id) => set({ selectedId: id }),

  setParams: (id, params) =>
    set((state) => ({
      elements: state.elements.map((e) => (e.id === id ? { ...e, params } : e)),
    })),

  setTransform: (id, patch) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === id ? { ...e, transform: { ...e.transform, ...patch } } : e,
      ),
    })),

  setProfile: (patch) => set((state) => ({ profile: { ...state.profile, ...patch } })),

  selectProfile: (id) =>
    set(() => {
      const source =
        findBuiltinProfile(id) ?? useLibrary.getState().customProfiles.find((p) => p.id === id)
      return source ? { profile: structuredClone(source) } : {}
    }),

  loadDocument: (snapshot) =>
    set({
      elements: snapshot.elements,
      profile: snapshot.profile,
      selectedId: snapshot.selectedId,
    }),

  notifyGeometry: () => set((state) => ({ elements: [...state.elements] })),
}))
