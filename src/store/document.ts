// The single source of truth: elements + machine profile + selection. The canvas and
// inspector are pure views over this; the canvas library (Konva) never becomes authoritative.
// On a Konva transform-end we read the affine back into here.
import { create } from 'zustand'
import type { DocElement, MachineProfile, Transform } from '../core/types'
import { IDENTITY_TRANSFORM } from '../core/types'
import { dropFromCache, generateLocal } from '../elements/registry'
import { defaultHandwritingParams } from '../elements/handwriting'
import '../elements/shapes' // side-effect: registers rect/ellipse/path before persistence boot
import { PRUSA_MK4, findBuiltinProfile } from './profiles'
import { useLibrary } from './library'
import { place } from '../core/pipeline/place'
import type { DocSnapshot } from './persistence/schema'

let seedCounter = 1

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'

interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Page-space bounding box of an element's placed geometry (for alignment). */
function pageBBox(el: DocElement): BBox | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of place(generateLocal(el), el.transform))
    for (const p of s.points) {
      if (p.x < x0) x0 = p.x
      if (p.y < y0) y0 = p.y
      if (p.x > x1) x1 = p.x
      if (p.y > y1) y1 = p.y
    }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
}

interface DocStore {
  elements: DocElement[]
  profile: MachineProfile
  selectedIds: string[]

  addHandwriting: (text?: string, at?: { x: number; y: number }) => void
  /** Add an element of any registered type at a page-space transform; selects it. Returns its id. */
  addElement: (type: string, params: unknown, transform?: Partial<Transform>) => string
  removeElement: (id: string) => void
  /** Remove every selected element. */
  removeSelected: () => void
  duplicateElement: (id: string) => void
  /** Duplicate every selected element (offset slightly) and select the copies. */
  duplicateSelected: () => void
  /** Replace selection with `id` (or clear with null); `additive` toggles `id` in/out. */
  select: (id: string | null, additive?: boolean) => void
  selectMany: (ids: string[]) => void
  clearSelection: () => void
  /** Move every selected element by (dx,dy) mm. */
  nudge: (dx: number, dy: number) => void
  /** Align selected elements' page bounding boxes to the group's bbox edge/centre. */
  align: (edge: AlignEdge) => void
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
  selectedIds: [],

  addHandwriting: (text = 'Kurvengefahr', at = { x: 20, y: 20 }) =>
    set((state) => {
      const params = defaultHandwritingParams(text)
      params.style.seed = ++seedCounter
      const el: DocElement = {
        id: crypto.randomUUID(),
        type: 'handwriting',
        transform: { ...IDENTITY_TRANSFORM, x: at.x, y: at.y },
        params,
      }
      return { elements: [...state.elements, el], selectedIds: [el.id] }
    }),

  addElement: (type, params, transform) => {
    const id = crypto.randomUUID()
    set((state) => ({
      elements: [...state.elements, { id, type, transform: { ...IDENTITY_TRANSFORM, ...transform }, params }],
      selectedIds: [id],
    }))
    return id
  },

  removeElement: (id) =>
    set((state) => {
      dropFromCache(id)
      return {
        elements: state.elements.filter((e) => e.id !== id),
        selectedIds: state.selectedIds.filter((s) => s !== id),
      }
    }),

  removeSelected: () =>
    set((state) => {
      state.selectedIds.forEach(dropFromCache)
      const sel = new Set(state.selectedIds)
      return { elements: state.elements.filter((e) => !sel.has(e.id)), selectedIds: [] }
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
      return { elements: [...state.elements, copy], selectedIds: [copy.id] }
    }),

  duplicateSelected: () =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      const copies = state.elements
        .filter((e) => sel.has(e.id))
        .map((el) => ({
          id: crypto.randomUUID(),
          type: el.type,
          transform: { ...el.transform, x: el.transform.x + 5, y: el.transform.y + 5 },
          params: structuredClone(el.params),
        }))
      if (!copies.length) return {}
      return { elements: [...state.elements, ...copies], selectedIds: copies.map((c) => c.id) }
    }),

  select: (id, additive = false) =>
    set((state) => {
      if (id === null) return { selectedIds: [] }
      if (additive)
        return {
          selectedIds: state.selectedIds.includes(id)
            ? state.selectedIds.filter((s) => s !== id)
            : [...state.selectedIds, id],
        }
      return { selectedIds: [id] }
    }),

  selectMany: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),

  nudge: (dx, dy) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      return {
        elements: state.elements.map((e) =>
          sel.has(e.id) ? { ...e, transform: { ...e.transform, x: e.transform.x + dx, y: e.transform.y + dy } } : e,
        ),
      }
    }),

  align: (edge) =>
    set((state) => {
      if (state.selectedIds.length < 2) return {}
      const boxes = new Map<string, BBox>()
      let gx0 = Infinity
      let gy0 = Infinity
      let gx1 = -Infinity
      let gy1 = -Infinity
      for (const id of state.selectedIds) {
        const el = state.elements.find((e) => e.id === id)
        const bb = el && pageBBox(el)
        if (!bb) continue
        boxes.set(id, bb)
        gx0 = Math.min(gx0, bb.x0)
        gy0 = Math.min(gy0, bb.y0)
        gx1 = Math.max(gx1, bb.x1)
        gy1 = Math.max(gy1, bb.y1)
      }
      if (!boxes.size) return {}
      const gcx = (gx0 + gx1) / 2
      const gcy = (gy0 + gy1) / 2
      const elements = state.elements.map((e) => {
        const bb = boxes.get(e.id)
        if (!bb) return e
        let dx = 0
        let dy = 0
        if (edge === 'left') dx = gx0 - bb.x0
        else if (edge === 'right') dx = gx1 - bb.x1
        else if (edge === 'centerX') dx = gcx - (bb.x0 + bb.x1) / 2
        else if (edge === 'top') dy = gy0 - bb.y0
        else if (edge === 'bottom') dy = gy1 - bb.y1
        else if (edge === 'centerY') dy = gcy - (bb.y0 + bb.y1) / 2
        return { ...e, transform: { ...e.transform, x: e.transform.x + dx, y: e.transform.y + dy } }
      })
      return { elements }
    }),

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
      selectedIds: snapshot.selectedIds,
    }),

  notifyGeometry: () => set((state) => ({ elements: [...state.elements] })),
}))
