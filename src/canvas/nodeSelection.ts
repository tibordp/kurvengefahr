// Transient selection of path nodes for on-canvas editing — view state only, never persisted
// (mirrors the drawing draft store). Holds which anchors (element + contour + node index) are
// selected so the Delete key can target nodes instead of the whole element, the NodeEditLayer can
// highlight them, and a drag can move the whole group. All selected nodes belong to one element.
// Cleared whenever the edited element changes.
//
// The node-level edits (delete, corner⇄smooth, insert on a segment) live here too, so the on-canvas
// gestures (NodeEditLayer) and the context menu drive exactly the same operations.
import { create } from 'zustand'
import { useDoc } from '../store/document'
import { splitCubic } from '../core/wasm/shapes'
import { cornerNode, type PathNode, type PathParams } from '../elements/shapes'

export interface NodeSel {
  elementId: string
  ci: number
  ni: number
}

interface Store {
  sels: NodeSel[]
  set: (s: NodeSel[]) => void
}

export const useNodeSelection = create<Store>((set) => ({ sels: [], set: (sels) => set({ sels }) }))

/** Clear the node selection; returns true if anything was actually selected. */
export function clearNodeSelection(): boolean {
  if (!useNodeSelection.getState().sels.length) return false
  useNodeSelection.getState().set([])
  return true
}

export function isNodeSelected(sels: NodeSel[], elementId: string, ci: number, ni: number): boolean {
  return sels.some((s) => s.elementId === elementId && s.ci === ci && s.ni === ni)
}

/** Selected node indices grouped by contour (for the current element only). */
function byContour(sels: NodeSel[], elementId: string): Map<number, Set<number>> {
  const m = new Map<number, Set<number>>()
  for (const s of sels) {
    if (s.elementId !== elementId) continue
    if (!m.has(s.ci)) m.set(s.ci, new Set())
    m.get(s.ci)!.add(s.ni)
  }
  return m
}

/** Delete every selected node. Drops a contour that falls below 2 nodes, and the whole element if
 *  no contours remain. Returns true if it consumed the action (any node was selected). */
export function deleteSelectedNodes(): boolean {
  const sels = useNodeSelection.getState().sels
  if (!sels.length) return false
  const elementId = sels[0].elementId
  const el = useDoc.getState().elements.find((e) => e.id === elementId)
  if (!el || el.type !== 'path') {
    clearNodeSelection()
    return false
  }
  const p = el.params as PathParams
  const rm = byContour(sels, elementId)
  const contours = p.contours
    .map((c, ci) => (rm.has(ci) ? { ...c, nodes: c.nodes.filter((_, k) => !rm.get(ci)!.has(k)) } : c))
    .filter((c) => c.nodes.length >= 2)
  useNodeSelection.getState().set([])
  if (contours.length === 0) useDoc.getState().removeElement(elementId)
  else useDoc.getState().setParams(elementId, { ...p, contours })
  return true
}

export const isCornerNode = (n: PathNode) => !n.hinX && !n.hinY && !n.houtX && !n.houtY

function pathParams(elementId: string): PathParams | null {
  const el = useDoc.getState().elements.find((e) => e.id === elementId)
  return el && el.type === 'path' ? (el.params as PathParams) : null
}

function setContourNodes(elementId: string, p: PathParams, ci: number, nodes: PathNode[]) {
  useDoc.getState().setParams(elementId, { ...p, contours: p.contours.map((c, j) => (j === ci ? { ...c, nodes } : c)) })
}

/** A node with symmetric handles synthesized from the neighbour direction (a "smooth" node). */
function smoothedNode(c: PathParams['contours'][number], ni: number): PathNode {
  const n = c.nodes.length
  const nd = c.nodes[ni]
  const prev = ni > 0 ? c.nodes[ni - 1] : c.closed ? c.nodes[n - 1] : nd
  const next = ni < n - 1 ? c.nodes[ni + 1] : c.closed ? c.nodes[0] : nd
  const dx = next.x - prev.x
  const dy = next.y - prev.y
  const len = Math.hypot(dx, dy) || 1
  const hl = ((Math.hypot(nd.x - prev.x, nd.y - prev.y) + Math.hypot(next.x - nd.x, next.y - nd.y)) / 2) * 0.25
  const ux = (dx / len) * hl
  const uy = (dy / len) * hl
  return { ...nd, houtX: ux, houtY: uy, hinX: -ux, hinY: -uy }
}

const cornered = (nd: PathNode): PathNode => ({ ...nd, hinX: 0, hinY: 0, houtX: 0, houtY: 0 })

/** Corner (no handles) ⇄ smooth for one node. Cusp nodes (independent handles) collapse to a
 *  corner first. */
export function toggleSmoothNode(elementId: string, ci: number, ni: number): void {
  const p = pathParams(elementId)
  if (!p) return
  const c = p.contours[ci]
  const nd = c.nodes[ni]
  const next = isCornerNode(nd) ? smoothedNode(c, ni) : cornered(nd)
  setContourNodes(elementId, p, ci, c.nodes.map((n, k) => (k === ni ? next : n)))
}

/** The selected nodes: how many, and whether every one is a corner (drives the menu's
 *  "Make smooth" / "Make corner" wording). */
export function selectedNodesSummary(elementId: string): { count: number; allCorner: boolean } {
  const p = pathParams(elementId)
  const sels = useNodeSelection.getState().sels.filter((s) => s.elementId === elementId)
  const nodes = p ? sels.map((s) => p.contours[s.ci]?.nodes[s.ni]).filter((n): n is PathNode => !!n) : []
  return { count: nodes.length, allCorner: nodes.every(isCornerNode) }
}

/** Make every selected node smooth (symmetric handles) or a corner (no handles). */
export function setSelectedNodesSmooth(smooth: boolean): void {
  const sels = useNodeSelection.getState().sels
  if (!sels.length) return
  const elementId = sels[0].elementId
  const p = pathParams(elementId)
  if (!p) return
  const rm = byContour(sels, elementId)
  const contours = p.contours.map((c, ci) => {
    const idxs = rm.get(ci)
    if (!idxs) return c
    return { ...c, nodes: c.nodes.map((n, k) => (idxs.has(k) ? (smooth ? smoothedNode(c, k) : cornered(n)) : n)) }
  })
  useDoc.getState().setParams(elementId, { ...p, contours })
}

/** Insert a node at the midpoint (t=0.5) of segment i→i+1 (i→0 for a closed contour's last
 *  segment). A straight segment gets a plain corner; a curved one is split via de Casteljau so the
 *  curve is unchanged. The new node becomes the selection. */
export function insertNodeOnSegment(elementId: string, ci: number, i: number): void {
  const p = pathParams(elementId)
  if (!p) return
  const c = p.contours[ci]
  const n = c.nodes.length
  const j = (i + 1) % n
  const a = c.nodes[i]
  const b = c.nodes[j]
  const straight = !a.houtX && !a.houtY && !b.hinX && !b.hinY
  const nodes = c.nodes.slice()
  let mid: PathNode
  if (straight) {
    mid = cornerNode((a.x + b.x) / 2, (a.y + b.y) / 2)
  } else {
    const s = splitCubic(a, { x: a.houtX, y: a.houtY }, { x: b.hinX, y: b.hinY }, b, 0.5)
    mid = { x: s[0], y: s[1], hinX: s[4], hinY: s[5], houtX: s[6], houtY: s[7] }
    nodes[i] = { ...a, houtX: s[2], houtY: s[3] }
    nodes[j] = { ...b, hinX: s[8], hinY: s[9] }
  }
  nodes.splice(i + 1, 0, mid) // j===0 (closing segment) ⇒ i is last ⇒ append
  setContourNodes(elementId, p, ci, nodes)
  useNodeSelection.getState().set([{ elementId, ci, ni: i + 1 }])
}
