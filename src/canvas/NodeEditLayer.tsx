// On-canvas editing for the selected path: draggable anchor dots + Bézier control handles, plus
// node-level edits — select an anchor (click), delete it (Del), convert corner↔smooth (double-click),
// break handle symmetry (Alt-drag a handle), and insert a node (click the small midpoint dot on a
// segment). Anchors and handles are authored in element-local mm; we map to/from page space through
// the element's transform so editing works even when the path is moved. Dragging writes params via
// setParams (which re-tessellates immediately). A selected path shows this instead of the
// Transformer; you still move the whole path by dragging its body.
import { Fragment, useEffect } from 'react'
import { Circle, Line } from 'react-konva'
import type Konva from 'konva'
import { useDoc } from '../store/document'
import { beginGesture, endGesture } from '../store/history'
import { localToPage, pageToLocal } from '../core/pipeline/place'
import { splitCubic } from '../core/wasm/shapes'
import { snap } from './snap'
import { cornerNode, type PathNode, type PathParams } from '../elements/shapes'
import { useNodeSelection, clearNodeSelection, isNodeSelected } from './nodeSelection'

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
  const setParams = useDoc((s) => s.setParams)
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

  if (!el || el.type !== 'path') return null

  const p = el.params as PathParams
  const t = el.transform
  const r = 4 / pxPerMm // anchor radius, screen-constant
  const hr = 3 / pxPerMm // handle radius
  const ir = 2.6 / pxPerMm // insert (midpoint) dot radius
  const lw = 1 / pxPerMm

  const setContourNodes = (ci: number, nodes: PathNode[]) =>
    setParams(el.id, { ...p, contours: p.contours.map((c, j) => (j === ci ? { ...c, nodes } : c)) })

  const updateNode = (ci: number, ni: number, patch: Partial<PathNode>) =>
    setContourNodes(
      ci,
      p.contours[ci].nodes.map((n, k) => (k === ni ? { ...n, ...patch } : n)),
    )

  const dragLocal = (e: Konva.KonvaEventObject<DragEvent>) => pageToLocal(t, e.target.x(), e.target.y())

  // Double-click an anchor: corner (no handles) ⇄ smooth (symmetric handles synthesized from the
  // neighbour direction). Cusp nodes (independent handles) collapse to a corner first.
  const toggleSmooth = (ci: number, ni: number) => {
    const c = p.contours[ci]
    const n = c.nodes.length
    const nd = c.nodes[ni]
    const corner = !nd.hinX && !nd.hinY && !nd.houtX && !nd.houtY
    if (!corner) {
      updateNode(ci, ni, { hinX: 0, hinY: 0, houtX: 0, houtY: 0 })
      return
    }
    const prev = ni > 0 ? c.nodes[ni - 1] : c.closed ? c.nodes[n - 1] : nd
    const next = ni < n - 1 ? c.nodes[ni + 1] : c.closed ? c.nodes[0] : nd
    const dx = next.x - prev.x
    const dy = next.y - prev.y
    const len = Math.hypot(dx, dy) || 1
    const hl = ((Math.hypot(nd.x - prev.x, nd.y - prev.y) + Math.hypot(next.x - nd.x, next.y - nd.y)) / 2) * 0.25
    const ux = (dx / len) * hl
    const uy = (dy / len) * hl
    updateNode(ci, ni, { houtX: ux, houtY: uy, hinX: -ux, hinY: -uy })
  }

  // Insert a node at the midpoint (t=0.5) of segment i→j. A straight segment gets a plain corner;
  // a curved one is split via de Casteljau so the curve is unchanged.
  const insertNode = (ci: number, i: number) => {
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
    setContourNodes(ci, nodes)
    setSels([{ elementId: el.id, ci, ni: i + 1 }])
  }

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
                    x={pg.x}
                    y={pg.y}
                    radius={ir}
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
                      insertNode(ci, i)
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
                  x={a.x}
                  y={a.y}
                  radius={selected ? r * 1.35 : r}
                  fill={selected ? '#ffffff' : '#e5484d'}
                  stroke={selected ? '#e5484d' : '#ffffff'}
                  strokeWidth={selected ? lw * 2 : lw}
                  draggable
                  onMouseDown={(e) => selectNode(ci, i, !!(e.evt as MouseEvent).shiftKey)}
                  onDblClick={(e) => {
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
