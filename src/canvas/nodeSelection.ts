// Transient selection of path nodes for on-canvas editing — view state only, never persisted
// (mirrors the drawing draft store). Holds which anchors (element + contour + node index) are
// selected so the Delete key can target nodes instead of the whole element, the NodeEditLayer can
// highlight them, and a drag can move the whole group. All selected nodes belong to one element.
// Cleared whenever the edited element changes.
import { create } from 'zustand'
import { useDoc } from '../store/document'
import type { PathParams } from '../elements/shapes'

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
