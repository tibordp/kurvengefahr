// The single source of truth: elements + machine profile + selection. The canvas and
// inspector are pure views over this; the canvas library (Konva) never becomes authoritative.
// On a Konva transform-end we read the affine back into here.
import { create } from 'zustand'
import type { DocElement, Fiducial, Group, MachineProfile, PenId, Transform } from '../core/types'
import { IDENTITY_TRANSFORM } from '../core/types'
import { dropFromCache, generateLocal } from '../elements/registry'
import { defaultHandwritingParams } from '../elements/handwriting'
import '../elements/shapes' // side-effect: registers rect/ellipse/path before persistence boot
import '../elements/raster' // side-effect: registers the raster image type before persistence boot
import { PRUSA_MK4, findBuiltinProfile } from './profiles'
import { useLibrary } from './library'
import { place } from '../core/pipeline/place'
import type { DocSnapshot } from './persistence/schema'
import type { Geometry, Point } from '../core/types'
import { cornerNode, defaultHatch, pathOutlineStrokes } from '../elements/shapes'
import type { Contour, PathNode, PathParams, RectParams, EllipseParams, Hatch } from '../elements/shapes'
import { rectGeometry, ellipseGeometry, booleanGeometry, simplifyPolyline, type Rings } from '../core/wasm/shapes'

let seedCounter = 1

// In-memory clipboard for copy/cut/paste. Module-level so it survives switching documents within a
// tab (paste into another doc). Holds deep clones; paste re-clones with fresh ids.
let clipboard: DocElement[] = []

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

/** Page-space closed-boundary rings of a closed shape (rect / ellipse / closed-contour path),
 *  independent of its hatch/stroke style. Empty for elements with nothing closed to combine. */
function boundaryRings(el: DocElement): Point[][] {
  let local: Geometry
  if (el.type === 'rect') {
    const p = el.params as RectParams
    local = rectGeometry(p.w, p.h, p.cornerRadius)
  } else if (el.type === 'ellipse') {
    const p = el.params as EllipseParams
    local = ellipseGeometry(p.rx, p.ry)
  } else if (el.type === 'path') {
    const p = el.params as PathParams
    const closed = p.contours.filter((c) => c.closed && c.nodes.length >= 3)
    if (!closed.length) return []
    local = pathOutlineStrokes(closed)
  } else {
    return []
  }
  return place(local, el.transform)
    .map((s) => s.points)
    .filter((pts) => pts.length >= 3)
}

/** Flatten rings into the WASM boolean input form (flat xy + CSR ring offsets, point units). */
function ringsBuffer(rings: Point[][]): Rings {
  const valid = rings.filter((r) => r.length >= 3)
  const total = valid.reduce((a, r) => a + r.length, 0)
  const xy = new Float32Array(total * 2)
  const starts = new Uint32Array(valid.length + 1)
  let o = 0
  for (let i = 0; i < valid.length; i++) {
    starts[i] = o
    for (const p of valid[i]) {
      xy[o * 2] = p.x
      xy[o * 2 + 1] = p.y
      o++
    }
  }
  starts[valid.length] = o
  return { xy, starts }
}

/** A polyline whose ends coincide is a closed contour. */
function isClosedPts(pts: Point[]): boolean {
  if (pts.length < 4) return false
  const a = pts[0]
  const b = pts[pts.length - 1]
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-3
}

/** A polyline of points → one path contour (corner nodes), dropping a duplicate closing vertex. */
function pointsToContour(pts: Point[]): Contour {
  const closed = isClosedPts(pts)
  const nodes = pts.map((p) => cornerNode(p.x, p.y))
  if (closed && nodes.length > 1) nodes.pop()
  return { nodes, closed }
}

/** Build an editable `path` element from any other element's geometry, preserving transform / pen /
 *  group / name. Shapes become their outline (keeping the hatch); ink (handwriting, raster, …) is
 *  expanded stroke-by-stroke into contours. Returns null if there's nothing to convert yet. */
function elementToPath(el: DocElement): DocElement | null {
  if (el.type === 'path') return null
  let contours: Contour[]
  let hatch = defaultHatch()
  if (el.type === 'rect' || el.type === 'ellipse') {
    const r = el.params as RectParams & EllipseParams
    const rings =
      el.type === 'rect' ? rectGeometry(r.w, r.h, r.cornerRadius) : ellipseGeometry(r.rx, r.ry)
    contours = rings.map((s) => pointsToContour(s.points))
    hatch = (el.params as { hatch?: Hatch }).hatch ?? defaultHatch()
  } else {
    const geom = generateLocal(el)
    if (!geom.length) return null // async type not generated yet — nothing to bake
    contours = geom.map((s) => pointsToContour(s.points))
  }
  contours = contours.filter((c) => c.nodes.length >= 2)
  if (!contours.length) return null
  return {
    id: crypto.randomUUID(),
    type: 'path',
    transform: el.transform,
    params: { contours, hatch } as PathParams,
    pen: el.pen,
    ...(el.groupId ? { groupId: el.groupId } : {}),
    ...(el.name ? { name: el.name } : {}),
  }
}

/** Drop groups left with no members (e.g. after deleting their last element). */
function pruneGroups(elements: DocElement[], groups: Group[]): Group[] {
  const used = new Set<string>()
  for (const e of elements) if (e.groupId) used.add(e.groupId)
  return groups.filter((g) => used.has(g.id))
}

/** The hatch a closed shape carries (so a boolean result inherits the topmost shape's fill). */
function hatchOf(el: DocElement): Hatch {
  if (el.type === 'rect') return (el.params as RectParams).hatch
  if (el.type === 'ellipse') return (el.params as EllipseParams).hatch
  if (el.type === 'path') return (el.params as PathParams).hatch
  return defaultHatch()
}

interface DocStore {
  elements: DocElement[]
  profile: MachineProfile
  selectedIds: string[]
  /** The document's single alignment fiducial (page-space mm), or null. */
  fiducial: Fiducial | null
  /** Organizational element groups for the Elements tree (membership is each element's `groupId`). */
  groups: Group[]

  addHandwriting: (text?: string, at?: { x: number; y: number }) => void
  /** Add an element of any registered type at a page-space transform; selects it. Returns its id. */
  addElement: (type: string, params: unknown, transform?: Partial<Transform>) => string
  /** Add many elements at once (one history step); selects them all. Optionally wrap them in a new
   *  group (e.g. an SVG import). Returns their ids. */
  addElements: (
    specs: { type: string; params: unknown; pen?: PenId; transform?: Partial<Transform> }[],
    group?: { name: string; collapsed?: boolean },
  ) => string[]
  /** Group the given elements under a new group; returns its id (empty string if <1 element). */
  createGroup: (elementIds: string[], name?: string) => string
  /** Dissolve a group, returning its members to the top level. */
  ungroup: (groupId: string) => void
  renameGroup: (groupId: string, name: string) => void
  setGroupCollapsed: (groupId: string, collapsed: boolean) => void
  /** Set (or clear, with '') an element's display name. */
  setElementName: (id: string, name: string) => void
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
  /** Combine selected closed shapes (rect/ellipse/closed path) with a boolean op (0 union,
   *  1 intersect, 2 difference, 3 xor), replacing them with one multi-contour path. One undo step. */
  booleanSelected: (op: number) => void
  /** Copy the selected elements to the in-tab clipboard (works across documents). */
  copySelected: () => void
  /** Copy + delete the selection. */
  cutSelected: () => void
  /** Paste the clipboard into this document (fresh ids, slight offset); selects the pasted copies. */
  paste: () => void
  /** Convert the given (or selected) non-path elements into editable `path` elements. */
  convertToPath: (ids?: string[]) => void
  /** Ramer–Douglas–Peucker ("rubber-band") simplify of the selected paths' contours, tolerance mm. */
  simplifySelected: (tolMm: number) => void
  /** Replace an element's params wholesale (caller merges). Invalidates Geometry. */
  setParams: (id: string, params: DocElement['params']) => void
  /** Patch an element's transform. Invalidates only Place. */
  setTransform: (id: string, patch: Partial<Transform>) => void
  /** Assign an element's pen. Not a param — invalidates only Place/Emit (no regenerate). */
  setPen: (id: string, pen: PenId) => void
  /** Assign every selected element to a pen. */
  setPenSelected: (pen: PenId) => void
  /** Place / move / clear the document fiducial (page-space mm). Re-emit only (no geometry). */
  setFiducial: (pt: Fiducial | null) => void
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
  fiducial: null,
  groups: [],

  addHandwriting: (text = 'Kurvengefahr', at = { x: 20, y: 20 }) =>
    set((state) => {
      const params = defaultHandwritingParams(text)
      params.style.seed = ++seedCounter
      const el: DocElement = {
        id: crypto.randomUUID(),
        type: 'handwriting',
        transform: { ...IDENTITY_TRANSFORM, x: at.x, y: at.y },
        params,
        pen: 0,
      }
      return { elements: [...state.elements, el], selectedIds: [el.id] }
    }),

  addElement: (type, params, transform) => {
    const id = crypto.randomUUID()
    set((state) => ({
      elements: [...state.elements, { id, type, transform: { ...IDENTITY_TRANSFORM, ...transform }, params, pen: 0 }],
      selectedIds: [id],
    }))
    return id
  },

  addElements: (specs, group) => {
    const groupId = group ? crypto.randomUUID() : undefined
    const created: DocElement[] = specs.map((s) => ({
      id: crypto.randomUUID(),
      type: s.type,
      transform: { ...IDENTITY_TRANSFORM, ...s.transform },
      params: s.params,
      pen: s.pen ?? 0,
      ...(groupId ? { groupId } : {}),
    }))
    set((state) => ({
      elements: [...state.elements, ...created],
      groups:
        group && groupId
          ? [...state.groups, { id: groupId, name: group.name, collapsed: group.collapsed ?? false }]
          : state.groups,
      selectedIds: created.map((c) => c.id),
    }))
    return created.map((c) => c.id)
  },

  createGroup: (elementIds, name) => {
    const ids = new Set(elementIds)
    if (ids.size < 1) return ''
    const groupId = crypto.randomUUID()
    set((state) => ({
      elements: state.elements.map((e) => (ids.has(e.id) ? { ...e, groupId } : e)),
      groups: [...state.groups, { id: groupId, name: name ?? 'Group', collapsed: false }],
    }))
    return groupId
  },

  ungroup: (groupId) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.groupId === groupId ? (({ groupId: _drop, ...rest }) => rest)(e) : e,
      ),
      groups: state.groups.filter((g) => g.id !== groupId),
    })),

  renameGroup: (groupId, name) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, name } : g)),
    })),

  setElementName: (id, name) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === id ? (name ? { ...e, name } : (({ name: _drop, ...rest }) => rest)(e)) : e,
      ),
    })),

  setGroupCollapsed: (groupId, collapsed) =>
    set((state) => ({
      groups: state.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)),
    })),

  removeElement: (id) =>
    set((state) => {
      dropFromCache(id)
      const elements = state.elements.filter((e) => e.id !== id)
      return {
        elements,
        groups: pruneGroups(elements, state.groups),
        selectedIds: state.selectedIds.filter((s) => s !== id),
      }
    }),

  removeSelected: () =>
    set((state) => {
      state.selectedIds.forEach(dropFromCache)
      const sel = new Set(state.selectedIds)
      const elements = state.elements.filter((e) => !sel.has(e.id))
      return { elements, groups: pruneGroups(elements, state.groups), selectedIds: [] }
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
        pen: el.pen,
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
          pen: el.pen,
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

  booleanSelected: (op) =>
    set((state) => {
      // Selected closed shapes, in document order (later = drawn on top), each with page-space rings.
      const shapes = state.elements
        .filter((e) => state.selectedIds.includes(e.id))
        .map((el) => ({ el, rings: boundaryRings(el) }))
        .filter((s) => s.rings.length > 0)
      if (shapes.length < 2) return {} // nothing to combine

      // Fold pairwise in order: union/xor accumulate, intersect runs, difference subtracts each clip.
      let acc: Rings = ringsBuffer(shapes[0].rings)
      let result: Geometry = []
      for (let i = 1; i < shapes.length; i++) {
        result = booleanGeometry(op, acc, ringsBuffer(shapes[i].rings))
        acc = ringsBuffer(result.map((s) => s.points))
      }

      const contours: Contour[] = result
        .map((s) => ({ nodes: s.points.map((p) => cornerNode(p.x, p.y)), closed: true }))
        .filter((c) => c.nodes.length >= 3)
      if (!contours.length) return {} // empty result (e.g. intersect of disjoint) — leave originals

      const top = shapes[shapes.length - 1].el
      const newEl: DocElement = {
        id: crypto.randomUUID(),
        type: 'path',
        transform: { ...IDENTITY_TRANSFORM },
        params: { contours, hatch: hatchOf(top) } as PathParams,
        pen: top.pen,
      }
      const removed = new Set(shapes.map((s) => s.el.id))
      removed.forEach(dropFromCache)
      const elements = [...state.elements.filter((e) => !removed.has(e.id)), newEl]
      return {
        elements,
        groups: pruneGroups(elements, state.groups),
        selectedIds: [newEl.id],
      }
    }),

  copySelected: () =>
    set((state) => {
      clipboard = state.elements.filter((e) => state.selectedIds.includes(e.id)).map((e) => structuredClone(e))
      return {}
    }),

  cutSelected: () =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      if (!sel.size) return {}
      clipboard = state.elements.filter((e) => sel.has(e.id)).map((e) => structuredClone(e))
      sel.forEach(dropFromCache)
      const elements = state.elements.filter((e) => !sel.has(e.id))
      return { elements, groups: pruneGroups(elements, state.groups), selectedIds: [] }
    }),

  paste: () =>
    set((state) => {
      if (!clipboard.length) return {}
      const created: DocElement[] = clipboard.map((e) => {
        const { groupId: _drop, ...rest } = structuredClone(e)
        return {
          ...rest,
          id: crypto.randomUUID(),
          transform: { ...rest.transform, x: rest.transform.x + 5, y: rest.transform.y + 5 },
        }
      })
      return { elements: [...state.elements, ...created], selectedIds: created.map((c) => c.id) }
    }),

  convertToPath: (ids) =>
    set((state) => {
      const targets = new Set(ids ?? state.selectedIds)
      const idMap = new Map<string, string>()
      const elements = state.elements.map((el) => {
        if (!targets.has(el.id) || el.type === 'path') return el
        const p = elementToPath(el)
        if (!p) return el
        dropFromCache(el.id)
        idMap.set(el.id, p.id)
        return p
      })
      if (idMap.size === 0) return {}
      return { elements, selectedIds: state.selectedIds.map((id) => idMap.get(id) ?? id) }
    }),

  simplifySelected: (tolMm) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      const tol = Math.max(0.01, tolMm)
      const elements = state.elements.map((el) => {
        if (!sel.has(el.id) || el.type !== 'path') return el
        const p = el.params as PathParams
        const contours = p.contours.map((c) => {
          if (c.nodes.length < 3) return c
          const stroke = pathOutlineStrokes([c])[0]
          if (!stroke || stroke.points.length < 3) return c
          const flat = new Float32Array(stroke.points.length * 2)
          stroke.points.forEach((pt, i) => ((flat[i * 2] = pt.x), (flat[i * 2 + 1] = pt.y)))
          const kept = simplifyPolyline(flat, tol)
          const nodes: PathNode[] = []
          for (let i = 0; i < kept.length; i += 2) nodes.push(cornerNode(kept[i], kept[i + 1]))
          // pathOutlineStrokes re-closed the contour (duplicate last vertex) — drop it again.
          if (c.closed && nodes.length > 1) {
            const a = nodes[0]
            const b = nodes[nodes.length - 1]
            if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-3) nodes.pop()
          }
          return { nodes, closed: c.closed }
        })
        return { ...el, params: { ...p, contours } }
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

  setPen: (id, pen) =>
    set((state) => ({
      elements: state.elements.map((e) => (e.id === id ? { ...e, pen } : e)),
    })),

  setPenSelected: (pen) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      return { elements: state.elements.map((e) => (sel.has(e.id) ? { ...e, pen } : e)) }
    }),

  setFiducial: (pt) => set({ fiducial: pt }),

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
      fiducial: snapshot.fiducial,
      groups: snapshot.groups ?? [],
    }),

  notifyGeometry: () => set((state) => ({ elements: [...state.elements] })),
}))
