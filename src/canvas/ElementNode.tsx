// One element on the canvas: a Konva Group at the element's transform, containing its
// local-mm strokes as Lines. The Group transform is the *view* of the element transform;
// on drag/transform end we read the affine back into the store (the authority).
import { Group, Line } from 'react-konva'
import type Konva from 'konva'
import type { DocElement } from '../core/types'
import { generateLocal } from '../elements/registry'
import { useDoc } from '../store/document'
import { useGeneration, isElementDirty } from '../core/generation'

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
  const pens = useDoc((s) => s.profile.pens)

  const geom = generateLocal(element)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'

  // Dim the ink when it's stale (params edited but not regenerated yet) — a conspicuous "this isn't
  // current" cue right on the canvas. While generating (status present) we keep full opacity so the
  // lines streaming in read clearly.
  const generating = useGeneration((s) => !!s.status[element.id])
  const dirty = !generating && isElementDirty(element.id, element.params)

  const commit = (node: Konva.Node) => {
    setTransform(element.id, {
      x: node.x(),
      y: node.y(),
      rotation: node.rotation(),
      scaleX: node.scaleX(),
      scaleY: node.scaleY(),
    })
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
      onMouseDown={() => select(element.id)}
      onTap={() => select(element.id)}
      onDragEnd={(e) => commit(e.target)}
      onTransformEnd={(e) => commit(e.target)}
    >
      {geom.map((stroke, i) => {
        const pts: number[] = []
        for (const p of stroke.points) pts.push(p.x, p.y)
        return (
          <Line
            key={i}
            points={pts}
            stroke={colorFor(stroke.pen)}
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
