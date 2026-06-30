// One element on the canvas: a Konva Group at the element's transform, containing its
// local-mm strokes as Lines. The Group transform is the *view* of the element transform;
// on drag/transform end we read the affine back into the store (the authority).
import { memo, useMemo } from 'react'
import { Group, Image as KonvaImage, Line, Rect } from 'react-konva'
import type { DocElement, Transform } from '../core/types'
import { pressureEnabled } from '../core/types'
import { generateLocal, isMultiPen } from '../elements/registry'
import { useDoc } from '../store/document'
import { useGeneration, needsManualRegen, provisionalScale } from '../core/generation'
import { useRasterImage } from './useRasterImage'
import type { RasterParams } from '../elements/raster'
import { useNodeInteraction } from './useNodeInteraction'
import { displayPenWidthMm, PEN_WIDTH_MM } from './penWidth'

interface Props {
  element: DocElement
  /** px-per-mm of the stage. Pen width is rendered constant in physical mm at the current
   *  zoom regardless of element scale — the pen doesn't get thicker when the text is bigger. */
  pxPerMm: number
  /** When false (preview mode), the element is dimmed and non-interactive. */
  interactive?: boolean
  /** Override the on-canvas transform (its effective page transform) for a clip member being edited
   *  in place — the element's own `transform` is clip-local, so we render through the composed one. */
  effective?: Transform
}

function ElementNodeImpl({ element, pxPerMm, interactive = true, effective }: Props) {
  const pens = useDoc((s) => s.profile.pens)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const handlers = useNodeInteraction(element)
  const t = effective ?? element.transform

  const geom = generateLocal(element)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  // Local geometry carries the generator's pens; the element's chosen pen is stamped on later in
  // the pipeline (page space). So colour single-pen elements by `element.pen`, and only honour a
  // stroke's own pen for natively multi-colour types.
  const multiPen = isMultiPen(element.type)
  const elementColor = colorFor(element.pen)
  // Pressure shows as line weight (display only). The element's single pressure is stamped in the
  // pipeline, but locally the strokes still carry the generator's flat pressure — so weight the
  // whole element by its own value. Multi-pen types (clip) vary per member, so leave them at full.
  const widthMm = multiPen ? PEN_WIDTH_MM : displayPenWidthMm(element.pressure ?? 1, pressureOn)

  // After a resize bakes a new box into params, the cached ink is still fit to the OLD box until the
  // re-trace lands. Rescale just the strokes (not the underlay, which is already at the new size) so
  // they track the handles instead of flashing the old size. 1×1 for everything else.
  const prov = provisionalScale(element.id, element.type, element.params)

  // Dim the ink when it's stale (params edited but not regenerated yet) — a conspicuous "this isn't
  // current" cue right on the canvas. While generating (status present) we keep full opacity so the
  // lines streaming in read clearly.
  const generating = useGeneration((s) => !!s.status[element.id])
  const dirty = !generating && needsManualRegen(element.id, element.type, element.params)

  // The Konva Lines are the expensive part for many-point elements: building each `points` array and
  // reconciling the nodes. Memoize them on the geometry + style so re-renders that don't change the
  // geometry (a transform/drag edit, a sibling's change) reuse the same Line elements untouched.
  const dash = element.dash
  const lines = useMemo(
    () =>
      geom.map((stroke, i) => {
        const pts: number[] = []
        for (const p of stroke.points) pts.push(p.x, p.y)
        return (
          <Line
            key={i}
            points={pts}
            stroke={multiPen ? colorFor(stroke.pen) : elementColor}
            // Width is constant in physical mm at the current zoom, unaffected by element scale
            // (strokeScaleEnabled false → mm × pxPerMm). Per-element pressure scales it for a weight
            // cue; the pen tip itself doesn't change — this is display only.
            strokeWidth={widthMm * pxPerMm}
            strokeScaleEnabled={false}
            // Reflect the element's dashed-stroke style here too (screen px, like strokeWidth).
            dash={dash ? [dash.dash * pxPerMm, dash.gap * pxPerMm] : undefined}
            lineCap="round"
            lineJoin="round"
            // Generous screen-space hit area so thin ink is easy to click (clicks bubble to the
            // Group). Selection is per-element, not per-stroke.
            hitStrokeWidth={12}
          />
        )
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geom, pxPerMm, elementColor, multiPen, pens, dash, widthMm],
  )

  return (
    <Group
      id={element.id}
      x={t.x}
      y={t.y}
      rotation={t.rotation}
      scaleX={t.scaleX}
      scaleY={t.scaleY}
      opacity={interactive ? (dirty ? 0.4 : 1) : 0.18}
      listening={interactive}
      draggable={interactive}
      {...handlers}
    >
      {element.type === 'raster' && <RasterBounds element={element} />}
      {element.type === 'raster' && <RasterUnderlay element={element} />}
      {/* Inner group carries the provisional resize scale for stale ink (1×1 normally). With
          strokeScaleEnabled false on the Lines, this scales positions but never pen width. */}
      <Group scaleX={prov.sx} scaleY={prov.sy}>
        {lines}
      </Group>
    </Group>
  )
}

/** Memoized so an unrelated store change (another element edited, an async geometry bump elsewhere)
 *  doesn't re-render every element. Re-renders only when this element's ref / zoom / interactivity
 *  changes — which now happens precisely (transform-only edits and worker geometry both bump just
 *  this element's ref). */
export const ElementNode = memo(ElementNodeImpl)

/** An invisible rect at the raster's physical box, so the element's bounds (and thus the selection
 *  Transformer) stay consistent even when it has no strokes and the source image is hidden — without
 *  it the Group would collapse to 0×0 and become un-resizable. `listening={false}` keeps click
 *  selection strokes-only (no new hit area). */
function RasterBounds({ element }: { element: DocElement }) {
  const p = element.params as RasterParams
  if (p.targetWidthMm <= 0 || p.targetHeightMm <= 0) return null
  return <Rect x={0} y={0} width={p.targetWidthMm} height={p.targetHeightMm} listening={false} />
}

/** The raster element's source image, drawn faintly under its traced strokes as a registration
 *  reference (it makes no marks — only the strokes plot). Null until the bitmap loads / if missing. */
function RasterUnderlay({ element }: { element: DocElement }) {
  const p = element.params as RasterParams
  const bitmap = useRasterImage(p.showUnderlay ? p.imageId : '')
  if (!p.showUnderlay || !bitmap || p.targetWidthMm <= 0 || p.targetHeightMm <= 0) return null
  return (
    <KonvaImage
      image={bitmap}
      x={0}
      y={0}
      width={p.targetWidthMm}
      height={p.targetHeightMm}
      opacity={0.2}
      listening={false}
    />
  )
}
