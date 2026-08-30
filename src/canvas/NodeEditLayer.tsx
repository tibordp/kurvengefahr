// On-canvas editing for the selected path: draggable anchor dots + Bézier control handles, plus
// node-level edits — select an anchor (click), delete it (Del), convert corner↔smooth (double-click),
// break handle symmetry (Alt-drag a handle), and insert a node (click the small midpoint dot on a
// segment). Anchors and handles are authored in element-local mm; we map to/from page space through
// the element's transform so editing works even when the path is moved. Dragging writes params via
// setParams (which re-tessellates immediately). A selected path shows this instead of the
// Transformer by default; you still move the whole path by dragging its body. Clicking the body
// again flips to the bounding-box Transformer (rotate/scale the whole path) — see `transformPathId`
// in the document store — and clicking once more flips back.
import { Fragment, useEffect } from 'react'
import { Circle, Line } from 'react-konva'
import type Konva from 'konva'
import { useDoc } from '../store/document'
import { beginGesture, endGesture } from '../store/history'
import { localToPage, pageToLocal, effectiveTransform } from '../core/pipeline/place'
import { snap } from './snap'
import type { PathNode, PathParams } from '../elements/shapes'
import {
  useNodeSelection,
  clearNodeSelection,
  isNodeSelected,
  toggleSmoothNode,
  insertNodeOnSegment,
} from './nodeSelection'
import { isCoarsePointer } from '../ui/mobile'
import { consumeLongPress } from './longPress'

/** Konva node names for the context menu: a long-press / right-click on one of these acts on the
 *  node (`elementId`, `ci`, `ni`) or segment (`elementId`, `ci`, `seg`) it carries as attrs. */
export const NODE_ANCHOR = 'node-anchor'
export const NODE_MIDPOINT = 'node-midpoint'

/** Cubic point at parameter t for the segment A→B (handles relative to anchors), in local mm. */
function cubicAt(a: PathNode, b: PathNode, t: number): { x: number; y: number } {
  const mt = 1 - t
  const c0 = mt * mt * mt
  const c1 = 3 * mt * mt * t
  const c2 = 3 * mt * t * t
  const c3 = t * t * t
  const p1x = a.x + a.houtX
  const p1y = a.y + a.houtY
  const p2x = b.x + b.hinX
  const p2y = b.y + b.hinY
  return {
    x: c0 * a.x + c1 * p1x + c2 * p2x + c3 * b.x,
    y: c0 * a.y + c1 * p1y + c2 * p2y + c3 * b.y,
  }
}

export function NodeEditLayer({ pxPerMm }: { pxPerMm: number }) {
  const el = useDoc((s) =>
    s.selectedIds.length === 1 ? (s.elements.find((e) => e.id === s.selectedIds[0]) ?? null) : null,
  )
  // A path flipped into whole-path Transformer mode shows the bounding box, not its control points.
  const transforming = useDoc((s) => s.transformPathId === s.selectedIds[0])
  const setParams = useDoc((s) => s.setParams)
  const elements = useDoc((s) => s.elements)
  const sels = useNodeSelection((s) => s.sels)
  const setSels = useNodeSelection((s) => s.set)

  // Node selection is per-element: clear it whenever the edited path changes (or this unmounts).
  const elId = el?.type === 'path' ? el.id : null
  useEffect(() => {
    clearNodeSelection()
    return () => {
      clearNodeSelection()
    }
  }, [elId])

  if (!el || el.type !== 'path' || transforming) return null

  const p = el.params as PathParams
  // Effective page transform — for a clip member this composes the clip chain, so handles land where
  // the (moved) clip actually is, and edits still commit in the path's own local coords.
  const t = el.parent ? effectiveTransform(el, new Map(elements.map((e) => [e.id, e]))) : el.transform
  const r = 4 / pxPerMm // anchor radius, screen-constant
  const hr = 3 / pxPerMm // handle radius
  const ir = 2.6 / pxPerMm // insert (midpoint) dot radius
  const lw = 1 / pxPerMm
  // Hit radius, larger than the drawn dot: a fingertip needs ~a 32 px target, a mouse gets a little
  // slack too. The visuals stay small so neighbouring nodes remain distinguishable.
  const hitR = (isCoarsePointer() ? 16 : 7) / pxPerMm
  const hitCircle = (ctx: Konva.Context, shape: Konva.Shape) => {
    ctx.beginPath()
    ctx.arc(0, 0, hitR, 0, Math.PI * 2, false)
    ctx.closePath()
    ctx.fillStrokeShape(shape)
  }

  const setContourNodes = (ci: number, nodes: PathNode[]) =>
    setParams(el.id, { ...p, contours: p.contours.map((c, j) => (j === ci ? { ...c, nodes } : c)) })

  const updateNode = (ci: number, ni: number, patch: Partial<PathNode>) =>
    setContourNodes(
      ci,
      p.contours[ci].nodes.map((n, k) => (k === ni ? { ...n, ...patch } : n)),
    )

  const dragLocal = (e: Konva.KonvaEventObject<DragEvent>) => pageToLocal(t, e.target.x(), e.target.y())

  // Double-click an anchor: corner ⇄ smooth; click a midpoint dot: insert a node on that segment.
  // (The operations themselves are shared with the context menu — see nodeSelection.ts.)
  const toggleSmooth = (ci: number, ni: number) => toggleSmoothNode(el.id, ci, ni)
  const insertNode = (ci: number, i: number) => insertNodeOnSegment(el.id, ci, i)

  // Click selects a node; Shift-click toggles it in/out of a multi-selection. Clicking an already-
  // selected node without Shift keeps the group, so the ensuing drag moves all selected nodes.
  const selectNode = (ci: number, ni: number, additive: boolean) => {
    const already = isNodeSelected(sels, el.id, ci, ni)
    if (additive) {
      setSels(
        already
          ? sels.filter((s) => !(s.elementId === el.id && s.ci === ci && s.ni === ni))
          : [...sels, { elementId: el.id, ci, ni }],
      )
    } else if (!already) {
      setSels([{ elementId: el.id, ci, ni }])
    }
  }

  // Move every selected node by (dx,dy) — used when dragging one node of a multi-selection.
  const moveSelected = (dx: number, dy: number) => {
    const sset = new Map<number, Set<number>>()
    for (const s of sels) {
      if (s.elementId !== el.id) continue
      if (!sset.has(s.ci)) sset.set(s.ci, new Set())
      sset.get(s.ci)!.add(s.ni)
    }
    setParams(el.id, {
      ...p,
      contours: p.contours.map((c, ci) => {
        const idxs = sset.get(ci)
        if (!idxs) return c
        return { ...c, nodes: c.nodes.map((n, k) => (idxs.has(k) ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }
      }),
    })
  }

  return (
    <>
      {p.contours.map((c, ci) => {
        const segCount = c.closed ? c.nodes.length : c.nodes.length - 1
        return (
          <Fragment key={`c${ci}`}>
            {/* Handle stems */}
            {c.nodes.map((n, i) => {
              const a = localToPage(t, n.x, n.y)
              const out = n.houtX || n.houtY ? localToPage(t, n.x + n.houtX, n.y + n.houtY) : null
              const inn = n.hinX || n.hinY ? localToPage(t, n.x + n.hinX, n.y + n.hinY) : null
              return (
                <Fragment key={`s${i}`}>
                  {out && <Line points={[a.x, a.y, out.x, out.y]} stroke="#9ca3af" strokeWidth={lw} listening={false} />}
                  {inn && <Line points={[a.x, a.y, inn.x, inn.y]} stroke="#9ca3af" strokeWidth={lw} listening={false} />}
                </Fragment>
              )
            })}

            {/* Midpoint insert dots (click to add a node on that segment) */}
            {segCount > 0 &&
              Array.from({ length: segCount }, (_, i) => {
                const j = (i + 1) % c.nodes.length
                const m = cubicAt(c.nodes[i], c.nodes[j], 0.5)
                const pg = localToPage(t, m.x, m.y)
                return (
                  <Circle
                    key={`m${i}`}
                    name={NODE_MIDPOINT}
                    elementId={el.id}
                    ci={ci}
                    seg={i}
                    x={pg.x}
                    y={pg.y}
                    radius={ir}
                    hitFunc={hitCircle}
                    fill="#ffffff"
                    stroke="#9ca3af"
                    strokeWidth={lw}
                    onMouseEnter={(e) => {
                      const stage = e.target.getStage()
                      if (stage) stage.container().style.cursor = 'copy'
                    }}
                    onMouseLeave={(e) => {
                      const stage = e.target.getStage()
                      if (stage) stage.container().style.cursor = ''
                    }}
                    onClick={(e) => {
                      e.cancelBubble = true
                      if (e.evt.button === 0) insertNode(ci, i) // right-click → context menu instead
                    }}
                    onTap={(e) => {
                      e.cancelBubble = true
                      if (!consumeLongPress()) insertNode(ci, i) // a long-press opened the menu instead
                    }}
                  />
                )
              })}

            {/* Handle dots (symmetric: dragging one mirrors the other; Alt-drag breaks symmetry) */}
            {c.nodes.map((n, i) => {
              const handle = (which: 'out' | 'in') => {
                const hx = which === 'out' ? n.houtX : n.hinX
                const hy = which === 'out' ? n.houtY : n.hinY
                if (!hx && !hy) return null
                const pos = localToPage(t, n.x + hx, n.y + hy)
                return (
                  <Circle
                    key={which}
                    x={pos.x}
                    y={pos.y}
                    radius={hr}
                    hitFunc={hitCircle}
                    fill="#6b7280"
                    draggable
                    onDragStart={beginGesture}
                    onDragEnd={endGesture}
                    onDragMove={(e) => {
                      const loc = dragLocal(e)
                      const ox = loc.x - n.x
                      const oy = loc.y - n.y
                      const broken = !!(e.evt as MouseEvent).altKey
                      updateNode(
                        ci,
                        i,
                        which === 'out'
                          ? broken
                            ? { houtX: ox, houtY: oy }
                            : { houtX: ox, houtY: oy, hinX: -ox, hinY: -oy }
                          : broken
                            ? { hinX: ox, hinY: oy }
                            : { hinX: ox, hinY: oy, houtX: -ox, houtY: -oy },
                      )
                    }}
                  />
                )
              }
              return (
                <Fragment key={`h${i}`}>
                  {handle('out')}
                  {handle('in')}
                </Fragment>
              )
            })}

            {/* Anchors */}
            {c.nodes.map((n, i) => {
              const a = localToPage(t, n.x, n.y)
              const selected = isNodeSelected(sels, el.id, ci, i)
              return (
                <Circle
                  key={`a${i}`}
                  name={NODE_ANCHOR}
                  elementId={el.id}
                  ci={ci}
                  ni={i}
                  x={a.x}
                  y={a.y}
                  radius={selected ? r * 1.35 : r}
                  hitFunc={hitCircle}
                  fill={selected ? '#ffffff' : '#e5484d'}
                  stroke={selected ? '#e5484d' : '#ffffff'}
                  strokeWidth={selected ? lw * 2 : lw}
                  draggable
                  onMouseDown={(e) => selectNode(ci, i, !!(e.evt as MouseEvent).shiftKey)}
                  onTouchStart={() => selectNode(ci, i, false)}
                  onDblClick={(e) => {
                    e.cancelBubble = true
                    toggleSmooth(ci, i)
                  }}
                  onDblTap={(e) => {
                    e.cancelBubble = true
                    toggleSmooth(ci, i)
                  }}
                  onDragStart={beginGesture}
                  onDragEnd={endGesture}
                  onDragMove={(e) => {
                    const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
                    e.target.position(sp)
                    const loc = pageToLocal(t, sp.x, sp.y)
                    const cur = p.contours[ci].nodes[i]
                    if (isNodeSelected(sels, el.id, ci, i) && sels.length > 1) {
                      moveSelected(loc.x - cur.x, loc.y - cur.y)
                    } else {
                      updateNode(ci, i, { x: loc.x, y: loc.y })
                    }
                  }}
                />
              )
            })}
          </Fragment>
        )
      })}
    </>
  )
}
