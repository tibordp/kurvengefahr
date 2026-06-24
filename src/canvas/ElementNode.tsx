// One element on the canvas: a Konva Group at the element's transform, containing its
// local-mm strokes as Lines. The Group transform is the *view* of the element transform;
// on drag/transform end we read the affine back into the store (the authority).
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

// The single active group-drag gesture, shared by every ElementNode (only one drag at a time).
// Konva's Transformer puts *every* selected node into its own drag (Transformer `_proxyDrag`), so
// each fires `onDragMove` — left to its own devices each would snap to the grid independently and
// shear the selection apart. So the first node to start a drag becomes the **anchor**: it owns grid
// snapping and computes one delta for the whole selection; the others just re-assert that delta
// (Konva keeps moving them to the raw pointer position, so they must snap back every frame).
let dragGesture: {
  anchorId: string
  starts: Map<string, { x: number; y: number }>
  dx: number
  dy: number
} | null = null

export function ElementNode({ element, pxPerMm, interactive = true }: Props) {
  const select = useDoc((s) => s.select)
  const setTransform = useDoc((s) => s.setTransform)
  const setParams = useDoc((s) => s.setParams)
  const pens = useDoc((s) => s.profile.pens)

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
        // The first node to start owns the gesture (the anchor). Konva will `startDrag` the rest of
        // the selection on the anchor's first move; they join this same gesture.
        if (dragGesture) return
        const { selectedIds, elements } = useDoc.getState()
        const group = selectedIds.includes(element.id) ? selectedIds : [element.id]
        const starts = new Map<string, { x: number; y: number }>()
        for (const id of group) {
          const o = elements.find((x) => x.id === id)
          if (o) starts.set(id, { x: o.transform.x, y: o.transform.y })
        }
        dragGesture = { anchorId: element.id, starts, dx: 0, dy: 0 }
      }}
      // The anchor snaps to the grid and drives the whole selection by one shared delta; every other
      // node re-asserts that delta (Konva keeps re-positioning it to the raw pointer each frame).
      // The anchor fires before the others in a frame, so its delta is fresh when they read it.
      onDragMove={(e) => {
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
          // No gesture (defensive): plain solo snap.
          const sp = snap({ x: e.target.x(), y: e.target.y() }, !!e.evt.altKey)
          e.target.position(sp)
          setTransform(element.id, { x: sp.x, y: sp.y })
        }
      }}
      onDragEnd={(e) => {
        commit(e.target)
        dragGesture = null
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
