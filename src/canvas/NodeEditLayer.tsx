// On-canvas editing for the selected path: draggable anchor dots + Bézier control handles. Anchors
// and handles are authored in element-local mm; we map to/from page space through the element's
// transform so editing works even when the path is moved. Dragging writes params via setParams
// (which re-tessellates immediately). A selected path shows this instead of the Transformer; you
// still move the whole path by dragging its body.
import { Fragment } from 'react'
import { Circle, Line } from 'react-konva'
import type Konva from 'konva'
import { useDoc } from '../store/document'
import { localToPage, pageToLocal } from '../core/pipeline/place'
import { snap } from './snap'
import type { PathNode, PathParams } from '../elements/shapes'

export function NodeEditLayer({ pxPerMm }: { pxPerMm: number }) {
  const el = useDoc((s) =>
    s.selectedIds.length === 1 ? (s.elements.find((e) => e.id === s.selectedIds[0]) ?? null) : null,
  )
  const setParams = useDoc((s) => s.setParams)
  if (!el || el.type !== 'path') return null

  const p = el.params as PathParams
  const t = el.transform
  const r = 4 / pxPerMm // anchor radius, screen-constant
  const hr = 3 / pxPerMm // handle radius
  const lw = 1 / pxPerMm

  const updateNode = (i: number, patch: Partial<PathNode>) =>
    setParams(el.id, { ...p, nodes: p.nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)) })

  const dragLocal = (e: Konva.KonvaEventObject<DragEvent>) => pageToLocal(t, e.target.x(), e.target.y())

  return (
    <>
      {/* Handle stems */}
      {p.nodes.map((n, i) => {
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

      {/* Handle dots (symmetric: dragging one mirrors the other, keeping the node smooth) */}
      {p.nodes.map((n, i) => {
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
              onDragMove={(e) => {
                const loc = dragLocal(e)
                const ox = loc.x - n.x
                const oy = loc.y - n.y
                updateNode(
                  i,
                  which === 'out'
                    ? { houtX: ox, houtY: oy, hinX: -ox, hinY: -oy }
                    : { hinX: ox, hinY: oy, houtX: -ox, houtY: -oy },
                )
              }}
            />
          )
        }
        return <Fragment key={`h${i}`}>{handle('out')}{handle('in')}</Fragment>
      })}

      {/* Anchors */}
      {p.nodes.map((n, i) => {
        const a = localToPage(t, n.x, n.y)
        return (
          <Circle
            key={`a${i}`}
            x={a.x}
            y={a.y}
            radius={r}
            fill="#e5484d"
            stroke="#ffffff"
            strokeWidth={lw}
            draggable
            onDragMove={(e) => {
              const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
              e.target.position(sp)
              const loc = pageToLocal(t, sp.x, sp.y)
              updateNode(i, { x: loc.x, y: loc.y })
            }}
          />
        )
      })}
    </>
  )
}
