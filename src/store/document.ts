// The single source of truth: elements + machine profile + selection. The canvas and
// inspector are pure views over this; the canvas library (Konva) never becomes authoritative.
// On a Konva transform-end we read the affine back into here.
import { create } from 'zustand'
import type { DocElement, Fiducial, EffectSpec, MachineProfile, PenId, Transform } from '../core/types'
import { IDENTITY_TRANSFORM } from '../core/types'
import { dropFromCache, generateLocal, isContainer } from '../elements/registry'
import { defaultHandwritingParams } from '../elements/handwriting'
import '../elements/shapes' // side-effect: registers rect/ellipse/path before persistence boot
import '../elements/text' // side-effect: registers the text element before persistence boot
import '../elements/generative' // side-effect: registers the generative element before persistence boot
import '../elements/raster' // side-effect: registers the raster image type before persistence boot
import '../elements/clip' // side-effect: registers the clip container element before persistence boot
import '../elements/group' // side-effect: registers the group container element before persistence boot
import { PRUSA_MK4, findBuiltinProfile } from './profiles'
import { writeDefaultProfile } from './persistence/storage'
import { useLibrary } from './library'
import {
  place,
  transformToMatrix,
  matrixToTransform,
  multiplyMatrix,
  composeTransforms,
  type Matrix,
} from '../core/pipeline/place'
import { elementLocalGeometry } from '../core/pipeline/clipGeometry'
import type { DocSnapshot } from './persistence/schema'
import type { Geometry, Point } from '../core/types'
import { cornerNode, defaultHatch, pathOutlineStrokes, weldContours } from '../elements/shapes'
import type { Contour, PathNode, PathParams, RectParams, EllipseParams, Hatch } from '../elements/shapes'
import { rectGeometry, ellipseGeometry, booleanGeometry, simplifyPolyline, type Rings } from '../core/wasm/shapes'

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
    ...(el.pressure !== undefined ? { pressure: el.pressure } : {}),
    ...(el.parent ? { parent: el.parent } : {}),
    ...(el.clipRole ? { clipRole: el.clipRole } : {}),
    ...(el.name ? { name: el.name } : {}),
  }
}

/** Bake an affine into a path node: full transform on the anchor, linear part on the handle vectors
 *  (which are relative, so no translation). */
function bakeNode(m: Matrix, n: PathNode): PathNode {
  return {
    x: m[0] * n.x + m[2] * n.y + m[4],
    y: m[1] * n.x + m[3] * n.y + m[5],
    hinX: m[0] * n.hinX + m[2] * n.hinY,
    hinY: m[1] * n.hinX + m[3] * n.hinY,
    houtX: m[0] * n.houtX + m[2] * n.houtY,
    houtY: m[1] * n.houtX + m[3] * n.houtY,
  }
}

/** An element's contours in its own local space (paths directly; others via {@link elementToPath}). */
function localContours(el: DocElement): Contour[] | null {
  if (el.type === 'path') return (el.params as PathParams).contours
  const p = elementToPath(el)
  return p ? (p.params as PathParams).contours : null
}

/** Drop container elements (group/clip) left with no members (e.g. after deleting their last
 *  member, or a boolean/convert consuming them). */
function pruneEmptyContainers(elements: DocElement[]): DocElement[] {
  const hasMembers = new Set<string>()
  for (const e of elements) if (e.parent) hasMembers.add(e.parent)
  return elements.filter((e) => !isContainer(e.type) || hasMembers.has(e.id))
}

/** Expand an id set to include every element transitively under any container in it — deleting a
 *  container takes its members (and nested containers' members) with it (unclip/ungroup to keep
 *  them). */
function withDescendants(ids: Set<string>, elements: DocElement[]): Set<string> {
  const out = new Set(ids)
  let added = true
  while (added) {
    added = false
    for (const e of elements) if (e.parent && out.has(e.parent) && !out.has(e.id)) (out.add(e.id), (added = true))
  }
  return out
}

/** All elements transitively under a container (members, nested containers' members, …). */
function descendants(id: string, elements: DocElement[]): Set<string> {
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop()!
    for (const e of elements) if (e.parent === cur && !out.has(e.id)) (out.add(e.id), stack.push(e.id))
  }
  return out
}

/** The given roots plus (for containers) their whole member subtree, in document order (members
 *  before their container — the z-order invariant). The unit of copy/duplicate/serialize, so a
 *  clip/group always travels with its contents, never as an empty shell. */
export function subtreeElements(rootIds: string[], elements: DocElement[]): DocElement[] {
  const want = new Set<string>(rootIds)
  for (const id of rootIds) for (const d of descendants(id, elements)) want.add(d)
  return elements.filter((e) => want.has(e.id))
}

/** Deep-clone a *self-contained* element list (e.g. {@link subtreeElements} output, or a pasted
 *  payload): fresh ids, `parent` remapped within the list. An element whose parent isn't in the list
 *  is a **root** — it drops to the top level (parent + stray mask role cleared) and is offset by
 *  (dx,dy); members keep their container-local transforms. Input order is preserved. */
export function cloneElementList(
  els: DocElement[],
  dx = 5,
  dy = 5,
): { clones: DocElement[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  for (const e of els) idMap.set(e.id, crypto.randomUUID())
  const clones = els.map((e) => {
    const clone = structuredClone(e)
    clone.id = idMap.get(e.id)!
    if (clone.parent && idMap.has(clone.parent)) {
      clone.parent = idMap.get(clone.parent)!
    } else {
      delete clone.parent
      delete clone.clipRole
      clone.transform = { ...clone.transform, x: clone.transform.x + dx, y: clone.transform.y + dy }
    }
    return clone
  })
  return { clones, idMap }
}

/** Deep-clone the given roots and (for containers) their whole member subtree, offsetting the roots.
 *  Used by duplicate so a clip/group clones as a whole tree, not an empty shell. `newRootIds` are the
 *  cloned ids of the requested roots that landed at the top level. */
export function cloneSubtrees(
  rootIds: string[],
  elements: DocElement[],
  dx = 5,
  dy = 5,
): { copies: DocElement[]; newRootIds: string[] } {
  const { clones, idMap } = cloneElementList(subtreeElements(rootIds, elements), dx, dy)
  const topLevel = new Set(clones.filter((c) => !c.parent).map((c) => c.id))
  const newRootIds = rootIds.map((id) => idMap.get(id)).filter((id): id is string => !!id && topLevel.has(id))
  return { copies: clones, newRootIds }
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

  addHandwriting: (text?: string, at?: { x: number; y: number }) => void
  /** Add an element of any registered type at a page-space transform; selects it. Returns its id. */
  addElement: (type: string, params: unknown, transform?: Partial<Transform>) => string
  /** Add many elements at once (one history step). Optionally wrap them in a new `group` container
   *  (e.g. an SVG import) — then the group is selected; otherwise the elements are. Returns the
   *  member ids (not the container's). */
  addElements: (
    specs: { type: string; params: unknown; pen?: PenId; transform?: Partial<Transform> }[],
    group?: { name: string },
  ) => string[]
  /** Group the given elements under a new `group` container; returns its id (empty string if <1
   *  element). Members keep their page positions (the container starts at identity). */
  createGroup: (elementIds: string[], name?: string) => string
  /** Dissolve a `group` container, baking its transform into members and returning them to the top
   *  level. */
  ungroup: (id: string) => void
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
  /** Mirror the selected elements about their combined page bounding-box centre (x = flip
   *  horizontal, y = flip vertical). Bakes a reflection into each element's transform (a negative
   *  scale, like rotation) — a cheap re-place/re-emit, never a regenerate. Works on any type,
   *  containers included. */
  flipSelected: (axis: 'x' | 'y') => void
  /** Combine selected closed shapes (rect/ellipse/closed path) with a boolean op (0 union,
   *  1 intersect, 2 difference, 3 xor), replacing them with one multi-contour path. One undo step. */
  booleanSelected: (op: number) => void
  /** Combine the selected elements into one multi-contour `path` (a compound path), baking each
   *  element's transform into its nodes so Bézier curves are preserved. Like booleans but open paths
   *  too; touching ends are welded by the optimizer at plot time. */
  joinSelected: () => void
  /** Clip-to-shape: consume the topmost selected element as the mask, wrap the rest into a new `clip`
   *  element (non-destructive, nestable). Needs ≥2 selected. */
  clipSelected: () => void
  /** Release a clip: bake its transform into the members, restore the mask, remove the clip. */
  unclip: (clipId: string) => void
  /** Weld each selected path's open contours that share endpoints into single continuous contours
   *  (closing any that loop), so an outline assembled from pieces can fill. Preserves Béziers. */
  weldSelected: () => void
  /** Break each selected multi-contour path into one path element per contour (release compound). */
  breakApartSelected: () => void
  /** Add pasted elements (fresh ids, slight offset, group membership dropped); selects them and
   *  returns the new ids. Clipboard I/O lives in `store/clipboard.ts` (the real system clipboard). */
  addPasted: (elements: DocElement[]) => string[]
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
  /** Set (or clear, with null) an element's dashed-stroke style. Re-place/re-emit only. */
  setDash: (id: string, dash: { dash: number; gap: number } | null) => void
  /** Set an element's pen pressure (0..1). Not a param — invalidates only Place/Emit. */
  setPressure: (id: string, pressure: number) => void
  /** Set (or clear, with []) an element's non-destructive effect stack. Not a param — invalidates
   *  only re-effect/re-place (the source stays editable), never a regenerate. */
  setEffects: (id: string, effects: EffectSpec[]) => void
  /** Assign every selected element to a pen. */
  setPenSelected: (pen: PenId) => void
  /** Set the pen pressure (0..1) on every selected element. */
  setPressureSelected: (pressure: number) => void
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
  /** Re-render an element whose worker-produced geometry landed (out-of-band cache). `id` bumps just
   *  that element's ref so memoized siblings stay put; omit to bump everything. */
  notifyGeometry: (id?: string) => void
}

export const useDoc = create<DocStore>((set) => ({
  elements: [],
  profile: PRUSA_MK4,
  selectedIds: [],
  fiducial: null,

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
      ...(groupId ? { parent: groupId } : {}),
    }))
    // A group container (identity transform) appended after its members, so members keep their page
    // positions and the whole import transforms as one unit.
    const container: DocElement[] =
      group && groupId
        ? [{ id: groupId, type: 'group', transform: { ...IDENTITY_TRANSFORM }, params: {}, pen: 0, name: group.name }]
        : []
    set((state) => ({
      elements: [...state.elements, ...created, ...container],
      selectedIds: groupId ? [groupId] : created.map((c) => c.id),
    }))
    return created.map((c) => c.id)
  },

  createGroup: (elementIds, name) => {
    const ids = new Set(elementIds)
    if (ids.size < 1) return ''
    const groupId = crypto.randomUUID()
    set((state) => {
      // Tag the members (keeping their transforms — the container starts at identity, so group-local
      // == page space and nothing visually moves), and append the container after them (z-order).
      const elements = state.elements.map((e) => (ids.has(e.id) ? { ...e, parent: groupId } : e))
      const container: DocElement = {
        id: groupId,
        type: 'group',
        transform: { ...IDENTITY_TRANSFORM },
        params: {},
        pen: 0,
        ...(name ? { name } : {}),
      }
      return { elements: [...elements, container], selectedIds: [groupId] }
    })
    return groupId
  },

  ungroup: (id) =>
    set((state) => {
      const group = state.elements.find((e) => e.id === id && e.type === 'group')
      if (!group) return {}
      const restored: string[] = []
      const elements = state.elements
        .filter((e) => e.id !== id)
        .map((e) => {
          if (e.parent !== id) return e
          restored.push(e.id)
          const { parent: _p, ...rest } = e
          return { ...rest, transform: composeTransforms(group.transform, e.transform) }
        })
      dropFromCache(id)
      return { elements: pruneEmptyContainers(elements), selectedIds: restored }
    }),

  setElementName: (id, name) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === id ? (name ? { ...e, name } : (({ name: _drop, ...rest }) => rest)(e)) : e,
      ),
    })),

  removeElement: (id) =>
    set((state) => {
      const kill = withDescendants(new Set([id]), state.elements)
      kill.forEach(dropFromCache)
      const elements = pruneEmptyContainers(state.elements.filter((e) => !kill.has(e.id)))
      return {
        elements,
        selectedIds: state.selectedIds.filter((s) => !kill.has(s)),
      }
    }),

  removeSelected: () =>
    set((state) => {
      const kill = withDescendants(new Set(state.selectedIds), state.elements)
      kill.forEach(dropFromCache)
      const elements = pruneEmptyContainers(state.elements.filter((e) => !kill.has(e.id)))
      return { elements, selectedIds: [] }
    }),

  duplicateElement: (id) =>
    set((state) => {
      if (!state.elements.some((e) => e.id === id)) return {}
      const { copies, newRootIds } = cloneSubtrees([id], state.elements)
      if (!copies.length) return {}
      return { elements: [...state.elements, ...copies], selectedIds: newRootIds }
    }),

  duplicateSelected: () =>
    set((state) => {
      const { copies, newRootIds } = cloneSubtrees(state.selectedIds, state.elements)
      if (!copies.length) return {}
      return { elements: [...state.elements, ...copies], selectedIds: newRootIds }
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

  flipSelected: (axis) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      if (!sel.size) return {}
      const membersOf = new Map<string, DocElement[]>()
      for (const e of state.elements)
        if (e.parent) membersOf.set(e.parent, [...(membersOf.get(e.parent) ?? []), e])
      // Combined page bbox of the selection's placed (post-effect) geometry — what the user sees.
      // Uses elementLocalGeometry so containers (no own generator) mirror about their real extent.
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (const el of state.elements) {
        if (!sel.has(el.id)) continue
        for (const s of place(elementLocalGeometry(el, membersOf), el.transform))
          for (const p of s.points) {
            if (p.x < x0) x0 = p.x
            if (p.y < y0) y0 = p.y
            if (p.x > x1) x1 = p.x
            if (p.y > y1) y1 = p.y
          }
      }
      if (!Number.isFinite(x0)) return {}
      const c = axis === 'x' ? (x0 + x1) / 2 : (y0 + y1) / 2
      // Reflection about the page line x=c (horizontal) / y=c (vertical), pre-multiplied onto each
      // element's page transform, then re-decomposed (the flip lands as a negative scale axis).
      const F: Matrix = axis === 'x' ? [-1, 0, 0, 1, 2 * c, 0] : [1, 0, 0, -1, 0, 2 * c]
      const elements = state.elements.map((e) =>
        sel.has(e.id)
          ? { ...e, transform: matrixToTransform(multiplyMatrix(F, transformToMatrix(e.transform))) }
          : e,
      )
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
      const elements = pruneEmptyContainers([...state.elements.filter((e) => !removed.has(e.id)), newEl])
      return {
        elements,
        selectedIds: [newEl.id],
      }
    }),

  joinSelected: () =>
    set((state) => {
      const sel = state.elements.filter((e) => state.selectedIds.includes(e.id))
      if (sel.length < 2) return {}
      // Bake every element's transform into its nodes and collect the contours into one path.
      const contours: Contour[] = []
      for (const el of sel) {
        const cs = localContours(el)
        if (!cs) continue
        const m = transformToMatrix(el.transform)
        for (const c of cs) {
          if (c.nodes.length < 2) continue
          contours.push({ nodes: c.nodes.map((n) => bakeNode(m, n)), closed: c.closed })
        }
      }
      if (!contours.length) return {}

      const top = sel[sel.length - 1]
      const newEl: DocElement = {
        id: crypto.randomUUID(),
        type: 'path',
        transform: { ...IDENTITY_TRANSFORM },
        params: { contours, hatch: hatchOf(top) } as PathParams,
        pen: top.pen,
      }
      const removed = new Set(sel.map((e) => e.id))
      removed.forEach(dropFromCache)
      const elements = pruneEmptyContainers([...state.elements.filter((e) => !removed.has(e.id)), newEl])
      return { elements, selectedIds: [newEl.id] }
    }),

  clipSelected: () =>
    set((state) => {
      const sel = state.elements.filter((e) => state.selectedIds.includes(e.id))
      if (sel.length < 2) return {}
      const clipId = crypto.randomUUID()
      const maskId = sel[sel.length - 1].id // topmost selected (drawn last) → the mask
      const selIds = new Set(sel.map((e) => e.id))
      const clip: DocElement = { id: clipId, type: 'clip', transform: { ...IDENTITY_TRANSFORM }, params: {}, pen: 0 }
      const elements = state.elements.map((e) =>
        selIds.has(e.id) ? { ...e, parent: clipId, ...(e.id === maskId ? { clipRole: 'mask' as const } : {}) } : e,
      )
      elements.push(clip)
      return { elements, selectedIds: [clipId] }
    }),

  unclip: (clipId) =>
    set((state) => {
      const clip = state.elements.find((e) => e.id === clipId && e.type === 'clip')
      if (!clip) return {}
      const restored: string[] = []
      const elements = state.elements
        .filter((e) => e.id !== clipId)
        .map((e) => {
          if (e.parent !== clipId) return e
          restored.push(e.id)
          const { parent: _p, clipRole: _cr, ...rest } = e
          return { ...rest, transform: composeTransforms(clip.transform, e.transform) }
        })
      dropFromCache(clipId)
      return { elements: pruneEmptyContainers(elements), selectedIds: restored }
    }),

  weldSelected: () =>
    set((state) => {
      let changed = false
      const elements = state.elements.map((el) => {
        if (!state.selectedIds.includes(el.id) || el.type !== 'path') return el
        const p = el.params as PathParams
        const welded = weldContours(p.contours)
        if (welded.length === p.contours.length) return el // nothing merged
        changed = true
        dropFromCache(el.id)
        return { ...el, params: { ...p, contours: welded } }
      })
      return changed ? { elements } : {}
    }),

  breakApartSelected: () =>
    set((state) => {
      let changed = false
      const created: string[] = []
      const elements = state.elements.flatMap((el) => {
        const p = el.params as PathParams
        if (!state.selectedIds.includes(el.id) || el.type !== 'path' || p.contours.length < 2) return [el]
        changed = true
        dropFromCache(el.id)
        return p.contours.map((c) => {
          const id = crypto.randomUUID()
          created.push(id)
          return {
            ...el,
            id,
            params: { ...p, contours: [c] },
          } as DocElement
        })
      })
      return changed ? { elements, selectedIds: created } : {}
    }),

  addPasted: (els) => {
    if (!els.length) return []
    // The payload is a self-contained subtree (a container carries its members), so remap parents
    // within it rather than dropping them — paste a group and you get the whole group back.
    const { clones } = cloneElementList(els)
    const roots = clones.filter((c) => !c.parent).map((c) => c.id)
    set((state) => ({
      elements: [...state.elements, ...clones],
      selectedIds: roots.length ? roots : clones.map((c) => c.id),
    }))
    return clones.map((c) => c.id)
  },

  convertToPath: (ids) =>
    set((state) => {
      const targets = new Set(ids ?? state.selectedIds)
      const idMap = new Map<string, string>()
      const removed = new Set<string>() // container members consumed by a flattened container
      let changed = false

      // Containers flatten *destructively*: bake the composed (group) / clipped (clip) geometry into
      // path(s) (one per pen so colours survive, grouped if several) and drop the container + members.
      const membersOf = new Map<string, DocElement[]>()
      for (const e of state.elements)
        if (e.parent) membersOf.set(e.parent, [...(membersOf.get(e.parent) ?? []), e])

      const out: DocElement[] = []
      for (const el of state.elements) {
        if (targets.has(el.id) && isContainer(el.type)) {
          const byPen = new Map<number, Contour[]>()
          for (const s of elementLocalGeometry(el, membersOf)) {
            const c = pointsToContour(s.points)
            if (c.nodes.length >= 2) byPen.set(s.pen, [...(byPen.get(s.pen) ?? []), c])
          }
          if (byPen.size === 0) {
            out.push(el) // nothing to bake — leave the container alone
            continue
          }
          changed = true
          dropFromCache(el.id)
          for (const d of descendants(el.id, state.elements)) {
            removed.add(d)
            dropFromCache(d)
          }
          const multi = byPen.size > 1
          const gid = multi ? crypto.randomUUID() : undefined
          const paths: DocElement[] = [...byPen.entries()].map(([pen, contours]) => ({
            id: crypto.randomUUID(),
            type: 'path',
            transform: { ...el.transform },
            params: { contours, hatch: defaultHatch() } as PathParams,
            pen,
            // A single result inherits the container's own parent; multiple are wrapped in a new group
            // (below) that inherits it instead.
            ...(gid ? { parent: gid } : el.parent ? { parent: el.parent } : {}),
            ...(el.name ? { name: el.name } : {}),
          }))
          out.push(...paths)
          if (gid)
            out.push({
              id: gid,
              type: 'group',
              transform: { ...IDENTITY_TRANSFORM },
              params: {},
              pen: 0,
              name: el.name ?? 'Group',
              ...(el.parent ? { parent: el.parent } : {}),
            })
          idMap.set(el.id, paths[0].id)
          continue
        }
        if (targets.has(el.id) && el.type !== 'path') {
          const p = elementToPath(el)
          if (p) {
            changed = true
            dropFromCache(el.id)
            idMap.set(el.id, p.id)
            out.push(p)
            continue
          }
        }
        out.push(el)
      }
      if (!changed) return {}
      // Drop any consumed container members (they may have appeared in the array before their container).
      const elements = pruneEmptyContainers(out.filter((e) => !removed.has(e.id)))
      return {
        elements,
        selectedIds: state.selectedIds.map((id) => idMap.get(id) ?? id).filter((id) => !removed.has(id)),
      }
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

  setDash: (id, dash) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === id ? (dash ? { ...e, dash } : (({ dash: _drop, ...rest }) => rest)(e)) : e,
      ),
    })),

  setPressure: (id, pressure) =>
    set((state) => {
      const p = Math.min(1, Math.max(0, pressure))
      return { elements: state.elements.map((e) => (e.id === id ? { ...e, pressure: p } : e)) }
    }),

  setEffects: (id, effects) =>
    set((state) => ({
      elements: state.elements.map((e) =>
        e.id === id ? (effects.length ? { ...e, effects } : (({ effects: _drop, ...rest }) => rest)(e)) : e,
      ),
    })),

  setPenSelected: (pen) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      return { elements: state.elements.map((e) => (sel.has(e.id) ? { ...e, pen } : e)) }
    }),

  setPressureSelected: (pressure) =>
    set((state) => {
      const sel = new Set(state.selectedIds)
      const p = Math.min(1, Math.max(0, pressure))
      return { elements: state.elements.map((e) => (sel.has(e.id) ? { ...e, pressure: p } : e)) }
    }),

  setFiducial: (pt) => set({ fiducial: pt }),

  // A profile edit (or switch) also becomes the sticky default for new documents.
  setProfile: (patch) => {
    const profile = { ...useDoc.getState().profile, ...patch }
    set({ profile })
    writeDefaultProfile(profile)
  },

  selectProfile: (id) => {
    const source =
      findBuiltinProfile(id) ?? useLibrary.getState().customProfiles.find((p) => p.id === id)
    if (!source) return
    const profile = structuredClone(source)
    set({ profile })
    writeDefaultProfile(profile)
  },

  loadDocument: (snapshot) =>
    set({
      elements: snapshot.elements,
      profile: snapshot.profile,
      selectedIds: snapshot.selectedIds,
      fiducial: snapshot.fiducial,
    }),

  notifyGeometry: (id) =>
    set((state) => ({
      // Bump only the regenerated element's ref (a no-op clone — same data) so memoized siblings
      // don't re-render. No id → bump the whole array (defensive fallback).
      elements: id
        ? state.elements.map((e) => (e.id === id ? { ...e } : e))
        : [...state.elements],
    })),
}))
