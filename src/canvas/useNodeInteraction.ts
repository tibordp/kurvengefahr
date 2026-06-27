// Shared canvas interaction for a positioned node (ElementNode, ClipNode): click-select, the
// grid-snapped multi-node drag (one anchor drives a shared delta), and resize/rotate commit that
// bakes scale into params for shape types (clip/handwriting keep scale in the transform). Extracted
// so a clip and an ordinary element drag through exactly the same gesture (and one undo step).
//
// Clip members are the exception: their stored transform is *clip-local*, but the canvas works in
// page space, so a member drags/transforms solo (no shared gesture) and commits through the inverse
// of its clip chain — keeping it pinned under the clip while you edit it in place.
import type Konva from 'konva'
import type { DocElement, Transform } from '../core/types'
import { applyScale, bakesScale } from '../elements/registry'
import { useDoc } from '../store/document'
import { beginGesture, endGesture } from '../store/history'
import { composeTransforms, effectiveTransform, invertTransform } from '../core/pipeline/place'
import { snap } from './snap'

const IDENTITY: Transform = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }

// The single active group-drag gesture, shared by every (non-member) node. Konva's Transformer drags
// *every* selected node, so each fires onDragMove; the first to start becomes the anchor (owns grid
// snapping + one shared delta), the rest re-assert that delta each frame.
let dragGesture: {
  anchorId: string
  starts: Map<string, { x: number; y: number }>
  dx: number
  dy: number
} | null = null

export interface NodeHandlers {
  onMouseDown: (e: Konva.KonvaEventObject<MouseEvent>) => void
  onTap: () => void
  onDragStart: () => void
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => void
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => void
  onTransformEnd: (e: Konva.KonvaEventObject<Event>) => void
}

/** The effective page transform of a clip member's *parent* (its clip chain) — what to invert to
 *  turn a page-space node transform back into the member's stored clip-local one. */
function parentChain(element: DocElement): Transform {
  if (!element.clipParent) return IDENTITY
  const { elements } = useDoc.getState()
  const byId = new Map(elements.map((e) => [e.id, e]))
  const parent = byId.get(element.clipParent)
  return parent ? effectiveTransform(parent, byId) : IDENTITY
}

/** Konva Group event handlers for a draggable/transformable node, wired to the document store. */
export function useNodeInteraction(element: DocElement): NodeHandlers {
  const select = useDoc((s) => s.select)
  const setTransform = useDoc((s) => s.setTransform)
  const setParams = useDoc((s) => s.setParams)

  // A clip member: convert the node's page transform back to clip-local (scale stays in the
  // transform — baking through a transformed chain is ambiguous).
  const commitMember = (node: Konva.Node) => {
    const chain = parentChain(element)
    const pageT: Transform = { x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: node.scaleX(), scaleY: node.scaleY() }
    setTransform(element.id, composeTransforms(invertTransform(chain), pageT))
  }

  const commitTop = (node: Konva.Node) => {
    const sx = node.scaleX()
    const sy = node.scaleY()
    if (bakesScale(element.type) && (sx !== 1 || sy !== 1)) {
      setParams(element.id, applyScale(element.type, element.params, sx, sy))
      node.scaleX(1)
      node.scaleY(1)
      setTransform(element.id, { x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: 1, scaleY: 1 })
    } else {
      setTransform(element.id, { x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: sx, scaleY: sy })
    }
  }

  const isMember = !!element.clipParent

  return {
    onMouseDown: (e) => {
      const additive = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey
      if (additive) select(element.id, true)
      else if (!useDoc.getState().selectedIds.includes(element.id)) select(element.id, false)
    },
    onTap: () => select(element.id),
    onDragStart: () => {
      beginGesture()
      if (isMember || dragGesture) return
      const { selectedIds, elements } = useDoc.getState()
      const group = selectedIds.includes(element.id) ? selectedIds : [element.id]
      const starts = new Map<string, { x: number; y: number }>()
      for (const id of group) {
        const o = elements.find((x) => x.id === id)
        if (o) starts.set(id, { x: o.transform.x, y: o.transform.y })
      }
      dragGesture = { anchorId: element.id, starts, dx: 0, dy: 0 }
    },
    onDragMove: (e) => {
      // A clip member drags solo in page space; we store the inverse-composed local transform, so it
      // re-renders right back under the pointer.
      if (isMember) {
        const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
        e.target.position(sp)
        commitMember(e.target)
        return
      }
      const g = dragGesture
      if (g && element.id === g.anchorId) {
        const start = g.starts.get(element.id)!
        const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
        g.dx = sp.x - start.x
        g.dy = sp.y - start.y
        const stage = e.target.getStage()
        for (const [id, s] of g.starts) {
          const nx = s.x + g.dx
          const ny = s.y + g.dy
          setTransform(id, { x: nx, y: ny })
          const node = id === element.id ? e.target : stage?.findOne('#' + id)
          node?.position({ x: nx, y: ny })
        }
      } else if (g) {
        const s = g.starts.get(element.id)
        if (s) e.target.position({ x: s.x + g.dx, y: s.y + g.dy })
      } else {
        const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
        e.target.position(sp)
        setTransform(element.id, { x: sp.x, y: sp.y })
      }
    },
    onDragEnd: (e) => {
      if (isMember) commitMember(e.target)
      else commitTop(e.target)
      dragGesture = null
      endGesture()
    },
    onTransformEnd: (e) => {
      beginGesture()
      if (isMember) commitMember(e.target)
      else commitTop(e.target)
      endGesture()
    },
  }
}
