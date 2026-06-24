// One element on the canvas: a Konva Group at the element's transform, containing its
// local-mm strokes as Lines. The Group transform is the *view* of the element transform;
// on drag/transform end we read the affine back into the store (the authority).
import { useRef } from 'react'
import { Group, Line } from 'react-konva'
import type Konva from 'konva'
import type { DocElement } from '../core/types'
import { generateLocal, bakesScale, applyScale, isMultiPen } from '../elements/registry'
import { useDoc } from '../store/document'
import { useGeneration, isElementDirty } from '../core/generation'
import { snap } from './snap'

interface Props {
  element: DocElement
  /** px-per-mm of the stage. Pen width is rendered constant in physical mm at the current
   *  zoom regardless of element scale — the pen doesn't get thicker when the text is bigger. */
  pxPerMm: number
  /** When false (preview mode), the element is dimmed and non-interactive. */
  interactive?: boolean
}

/** Nominal pen-tip width. Later this comes from the pen/machine profile, not the element. */
const PEN_WIDTH_MM = 0.4

export function ElementNode({ element, pxPerMm, interactive = true }: Props) {
  const select = useDoc((s) => s.select)
  const setTransform = useDoc((s) => s.setTransform)
  const setParams = useDoc((s) => s.setParams)
  const pens = useDoc((s) => s.profile.pens)
  // Captured at drag-start: this element's origin + the other selected elements' origins, so a
  // group drag moves them all by the same delta.
  const dragRef = useRef<{ sx: number; sy: number; others: { id: string; x: number; y: number }[] } | null>(null)

  const geom = generateLocal(element)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  // Local geometry carries the generator's pens; the element's chosen pen is stamped on later in
  // the pipeline (page space). So colour single-pen elements by `element.pen`, and only honour a
  // stroke's own pen for natively multi-colour types.
  const multiPen = isMultiPen(element.type)
  const elementColor = colorFor(element.pen)

  // Dim the ink when it's stale (params edited but not regenerated yet) — a conspicuous "this isn't
  // current" cue right on the canvas. While generating (status present) we keep full opacity so the
  // lines streaming in read clearly.
  const generating = useGeneration((s) => !!s.status[element.id])
  const dirty = !generating && isElementDirty(element.id, element.type, element.params)

  const commit = (node: Konva.Node) => {
    const sx = node.scaleX()
    const sy = node.scaleY()
    // Shape types bake resize into their params (real W/H / radii / node coords) and reset scale to
    // 1, so re-tessellation stays crisp; handwriting keeps the scale in its transform.
    if (bakesScale(element.type) && (sx !== 1 || sy !== 1)) {
      setParams(element.id, applyScale(element.type, element.params, sx, sy))
      node.scaleX(1)
      node.scaleY(1)
      setTransform(element.id, { x: node.x(), y: node.y(), rotation: node.rotation(), scaleX: 1, scaleY: 1 })
    } else {
      setTransform(element.id, {
        x: node.x(),
        y: node.y(),
        rotation: node.rotation(),
        scaleX: sx,
        scaleY: sy,
      })
    }
  }

  return (
    <Group
      id={element.id}
      x={element.transform.x}
      y={element.transform.y}
      rotation={element.transform.rotation}
      scaleX={element.transform.scaleX}
      scaleY={element.transform.scaleY}
      opacity={interactive ? (dirty ? 0.4 : 1) : 0.18}
      listening={interactive}
      draggable={interactive}
      onMouseDown={(e) => {
        const additive = e.evt.shiftKey || e.evt.metaKey || e.evt.ctrlKey
        if (additive) select(element.id, true)
        else if (!useDoc.getState().selectedIds.includes(element.id)) select(element.id, false)
        // else: already in the selection — keep it, so dragging moves the whole group.
      }}
      onTap={() => select(element.id)}
      onDragStart={() => {
        const { selectedIds, elements } = useDoc.getState()
        const group = selectedIds.includes(element.id) ? selectedIds : [element.id]
        dragRef.current = {
          sx: element.transform.x,
          sy: element.transform.y,
          others: group
            .filter((id) => id !== element.id)
            .map((id) => {
              const o = elements.find((x) => x.id === id)!
              return { id, x: o.transform.x, y: o.transform.y }
            }),
        }
      }}
      // Snap the element origin to the grid while dragging; carry the rest of the selection by the
      // same delta. Live store update so a path's node overlay tracks the move (cheap re-place).
      onDragMove={(e) => {
        const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
        e.target.position(sp)
        setTransform(element.id, { x: sp.x, y: sp.y })
        const ds = dragRef.current
        if (ds) {
          const dx = sp.x - ds.sx
          const dy = sp.y - ds.sy
          for (const o of ds.others) setTransform(o.id, { x: o.x + dx, y: o.y + dy })
        }
      }}
      onDragEnd={(e) => {
        commit(e.target)
        dragRef.current = null
      }}
      onTransformEnd={(e) => commit(e.target)}
    >
      {geom.map((stroke, i) => {
        const pts: number[] = []
        for (const p of stroke.points) pts.push(p.x, p.y)
        return (
          <Line
            key={i}
            points={pts}
            stroke={multiPen ? colorFor(stroke.pen) : elementColor}
            // Pen width is a property of the pen, not the element: keep it constant in
            // physical mm at the current zoom, unaffected by the element's scale. With
            // strokeScaleEnabled false, strokeWidth is in screen px → use mm × pxPerMm.
            strokeWidth={PEN_WIDTH_MM * pxPerMm}
            strokeScaleEnabled={false}
            lineCap="round"
            lineJoin="round"
            // Generous screen-space hit area so thin ink is easy to click (clicks bubble to
            // the Group). Selection is per-element, not per-stroke.
            hitStrokeWidth={12}
          />
        )
      })}
    </Group>
  )
}
