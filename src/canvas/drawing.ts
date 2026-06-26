// Drawing-tool interaction: turns pointer events (in page-mm) into new shape elements. The
// in-progress "draft" lives in its own tiny store so only the preview overlay re-renders during a
// drag — the canvas and its elements don't. Canvas wires its Stage pointer handlers to the
// exported functions when a draw tool is active; DrawingPreview renders `useDraft().draft`.
//
// All coordinates here are page-mm. On commit we anchor the element's transform at the shape's
// natural origin (rect top-left, ellipse centre, path first node) and store params relative to it.
import { create } from 'zustand'
import { useTools } from '../store/tools'
import { useDoc } from '../store/document'
import {
  cornerNode,
  defaultRectParams,
  defaultEllipseParams,
  defaultPathParams,
  type PathNode,
} from '../elements/shapes'
import { simplifyPolyline } from '../core/wasm/shapes'
import { snap } from './snap'

export interface Pt {
  x: number
  y: number
}

/** Pointer modifiers passed from the Canvas. */
export interface Mods {
  scale: number
  shift?: boolean
  alt?: boolean
}

export type Draft =
  | { kind: 'box'; tool: 'rect' | 'ellipse' | 'line'; a: Pt; b: Pt }
  | {
      kind: 'pen'
      nodes: PathNode[]
      cursor: Pt
      activeIndex: number | null
      dragging: boolean
      /** Cursor is over the first node — clicking will close the path (drives the preview ring). */
      closeHover: boolean
    }
  | { kind: 'freehand'; pts: Pt[] }
  | null

interface DraftStore {
  draft: Draft
  set: (d: Draft) => void
}
export const useDraft = create<DraftStore>((set) => ({ draft: null, set: (draft) => set({ draft }) }))

const getDraft = () => useDraft.getState().draft
const setDraft = (d: Draft) => useDraft.getState().set(d)
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export function cancelDraft(): void {
  if (getDraft()) setDraft(null)
}

// Shift-constrain a box drag: square for rect/ellipse, 45° snap for line.
function constrain(tool: 'rect' | 'ellipse' | 'line', a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (tool === 'line') {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const len = Math.hypot(dx, dy)
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s }
}

// ---- commit helpers (draft → element) ----------------------------------------------------------

/** Shift path nodes so they're relative to an origin (handles are already relative). */
function relativeTo(nodes: PathNode[], ox: number, oy: number): PathNode[] {
  return nodes.map((n) => ({ ...n, x: n.x - ox, y: n.y - oy }))
}

function finishBox(d: Extract<Draft, { kind: 'box' }>): void {
  const { tool, a, b } = d
  const add = useDoc.getState().addElement
  if (tool === 'rect') {
    let x = Math.min(a.x, b.x)
    let y = Math.min(a.y, b.y)
    let w = Math.abs(b.x - a.x)
    let h = Math.abs(b.y - a.y)
    if (w < 0.5 && h < 0.5) ((w = 40), (h = 25), (x = a.x), (y = a.y)) // click → default size
    add('rect', defaultRectParams(w, h), { x, y })
  } else if (tool === 'ellipse') {
    let cx = (a.x + b.x) / 2
    let cy = (a.y + b.y) / 2
    let rx = Math.abs(b.x - a.x) / 2
    let ry = Math.abs(b.y - a.y) / 2
    if (rx < 0.5 && ry < 0.5) ((rx = 20), (ry = 20), (cx = a.x), (cy = a.y))
    add('ellipse', defaultEllipseParams(rx, ry), { x: cx, y: cy })
  } else {
    if (dist(a, b) < 0.5) return cancelDraft() // a click is not a line
    const nodes = [cornerNode(0, 0), cornerNode(b.x - a.x, b.y - a.y)]
    add('path', { ...defaultPathParams(), contours: [{ nodes, closed: false }] }, { x: a.x, y: a.y })
  }
  setDraft(null)
  useTools.getState().setTool('select')
}

function finishPen(d: Extract<Draft, { kind: 'pen' }>, closed: boolean): void {
  if (d.nodes.length < 2) return cancelDraft()
  const o = d.nodes[0]
  useDoc.getState().addElement(
    'path',
    { ...defaultPathParams(), contours: [{ nodes: relativeTo(d.nodes, o.x, o.y), closed }] },
    { x: o.x, y: o.y },
  )
  setDraft(null)
  useTools.getState().setTool('select')
}

function finishFreehand(d: Extract<Draft, { kind: 'freehand' }>): void {
  if (d.pts.length < 2) return cancelDraft()
  const flat = new Float32Array(d.pts.length * 2)
  d.pts.forEach((p, i) => ((flat[i * 2] = p.x), (flat[i * 2 + 1] = p.y)))
  const kept = simplifyPolyline(flat, 0.4)
  if (kept.length < 4) return cancelDraft()
  const ox = kept[0]
  const oy = kept[1]
  const nodes: PathNode[] = []
  for (let i = 0; i < kept.length; i += 2) nodes.push(cornerNode(kept[i] - ox, kept[i + 1] - oy))
  useDoc.getState().addElement('path', { ...defaultPathParams(), contours: [{ nodes, closed: false }] }, { x: ox, y: oy })
  setDraft(null)
  useTools.getState().setTool('select')
}

// ---- pointer handlers (called by Canvas) -------------------------------------------------------

export function drawPointerDown(p: Pt, mods: Mods): void {
  const tool = useTools.getState().tool
  const d = getDraft()
  const sp = snap(p, !!mods.alt)

  if (tool === 'rect' || tool === 'ellipse' || tool === 'line') {
    setDraft({ kind: 'box', tool, a: sp, b: sp })
  } else if (tool === 'pen') {
    if (d && d.kind === 'pen') {
      // Close when clicking near the first node (proximity uses the raw point, snap-independent).
      if (d.nodes.length >= 2 && dist(p, d.nodes[0]) < 8 / mods.scale) return finishPen(d, true)
      const nodes = [...d.nodes, cornerNode(sp.x, sp.y)]
      setDraft({ kind: 'pen', nodes, cursor: sp, activeIndex: nodes.length - 1, dragging: true, closeHover: false })
    } else {
      setDraft({ kind: 'pen', nodes: [cornerNode(sp.x, sp.y)], cursor: sp, activeIndex: 0, dragging: true, closeHover: false })
    }
  } else if (tool === 'freehand') {
    setDraft({ kind: 'freehand', pts: [sp] })
  } else if (tool === 'handwriting') {
    useDoc.getState().addHandwriting(undefined, sp)
    useTools.getState().setTool('select')
  } else if (tool === 'fiducial') {
    // Singleton: placing simply sets (or moves) the one document fiducial.
    useDoc.getState().setFiducial(sp)
    useTools.getState().setTool('select')
  }
}

export function drawPointerMove(p: Pt, mods: Mods): void {
  const d = getDraft()
  if (!d) return
  const sp = snap(p, !!mods.alt)
  if (d.kind === 'box') {
    setDraft({ ...d, b: mods.shift ? constrain(d.tool, d.a, sp) : sp })
  } else if (d.kind === 'pen') {
    if (d.dragging && d.activeIndex != null) {
      const a = d.nodes[d.activeIndex]
      const houtX = sp.x - a.x
      const houtY = sp.y - a.y
      const nodes = d.nodes.slice()
      nodes[d.activeIndex] = { ...a, houtX, houtY, hinX: -houtX, hinY: -houtY } // symmetric handles
      setDraft({ ...d, nodes, cursor: sp, closeHover: false })
    } else {
      // Over the first node → snap the rubber-band to it and flag the close ring (snap-independent).
      const closeHover = d.nodes.length >= 2 && dist(p, d.nodes[0]) < 8 / mods.scale
      setDraft({ ...d, cursor: closeHover ? { x: d.nodes[0].x, y: d.nodes[0].y } : sp, closeHover })
    }
  } else if (d.kind === 'freehand') {
    const last = d.pts[d.pts.length - 1]
    if (dist(sp, last) >= 0.4) setDraft({ ...d, pts: [...d.pts, sp] })
  }
}

export function drawPointerUp(): void {
  const d = getDraft()
  if (!d) return
  if (d.kind === 'box') finishBox(d)
  else if (d.kind === 'pen') setDraft({ ...d, dragging: false, activeIndex: null }) // keep drafting
  else if (d.kind === 'freehand') finishFreehand(d)
}

/** Finish the in-progress pen path open (committing the nodes placed so far, no extra node added) —
 *  the shared action behind double-click and right-click, so a two-node curved segment is possible.
 *  Returns true if a pen draft was finished. */
export function finishPenPath(): boolean {
  const d = getDraft()
  if (d && d.kind === 'pen') {
    finishPen(d, false)
    return true
  }
  return false
}

/** Konva fires `dblclick` on ANY two clicks within its time window — even at different positions —
 *  so two quickly-placed (distinct) pen points would falsely finish the path. Only treat it as a
 *  finish when it's a genuine *in-place* double-click: the last two nodes coincide (within `tolMm`).
 *  Then drop the duplicate node and finish open. Otherwise it's two intentional points — ignore. */
export function drawDblClick(tolMm: number): void {
  const d = getDraft()
  if (!d || d.kind !== 'pen') return
  const n = d.nodes.length
  if (n < 2) return
  if (dist(d.nodes[n - 1], d.nodes[n - 2]) <= tolMm) {
    finishPen({ ...d, nodes: d.nodes.slice(0, n - 1) }, false)
  }
}

/** Returns true if it consumed the key (Enter finishes a pen path, Esc cancels / returns to Select). */
export function drawKey(e: KeyboardEvent): boolean {
  const d = getDraft()
  if (e.key === 'Enter' && d && d.kind === 'pen') {
    finishPen(d, false)
    return true
  }
  if (e.key === 'Escape') {
    if (d) cancelDraft()
    else useTools.getState().setTool('select')
    return true
  }
  return false
}
