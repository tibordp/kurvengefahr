// One element on the canvas: a Konva Group at the element's transform, containing its
// local-mm strokes as Lines. The Group transform is the *view* of the element transform;
// on drag/transform end we read the affine back into the store (the authority).
import { memo, useMemo } from 'react'
import { Group, Image as KonvaImage, Rect } from 'react-konva'
import type { DocElement, Transform } from '../core/types'
import { pressureEnabled } from '../core/types'
import { getProvisionalExtent, isMultiPen } from '../elements/registry'
import { effectedLocal } from '../core/pipeline/clipGeometry'
import { useDoc } from '../store/document'
import { useUI } from '../store/ui'
import { useGeneration, needsManualRegen, provisionalScale } from '../core/generation'
import { useRasterImage } from './useRasterImage'
import type { RasterParams } from '../elements/raster'
import { useNodeInteraction } from './useNodeInteraction'
import { InkStrokes } from './InkStrokes'
import { isMobileViewport } from '../ui/mobile'

interface Props {
  element: DocElement
  /** px-per-mm of the stage. Pen width is rendered constant in physical mm at the current
   *  zoom regardless of element scale — the pen doesn't get thicker when the text is bigger. */
  pxPerMm: number
  /** When false (preview mode), the element is dimmed and non-interactive. */
  interactive?: boolean
  /** Share viewer: full-opacity ink with zero interaction — unlike `interactive={false}`, which
   *  means "muted preview". Also suppresses the stale-params dimming (a viewer regenerates from
   *  params, so what's on screen is never stale). */
  readOnly?: boolean
  /** Override the on-canvas transform (its effective page transform) for a clip member being edited
   *  in place — the element's own `transform` is clip-local, so we render through the composed one. */
  effective?: Transform
}

function ElementNodeImpl({ element, pxPerMm, interactive = true, readOnly = false, effective }: Props) {
  const pens = useDoc((s) => s.profile.pens)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const handlers = useNodeInteraction(element)
  const t = effective ?? element.transform

  // Effected local geometry — the post-effect strokes that actually plot (the source stays editable;
  // NodeEditLayer/GhostLayer show the pre-effect shape). Memoized in effectedLocal, so this is cheap.
  const geom = effectedLocal(element)
  // Stable across renders (only `pens` changes it) so InkStrokes' memoized draws hold.
  const colorFor = useMemo(() => (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a', [pens])
  // Local geometry carries the generator's pens; the element's chosen pen is stamped on later in
  // the pipeline (page space). So colour single-pen elements by `element.pen`, and only honour a
  // stroke's own pen for natively multi-colour types.
  const multiPen = isMultiPen(element.type)
  const elementColor = colorFor(element.pen)
  // Pressure shows as line weight (display only): the element's single pressure is a display gain on
  // the generator's per-point pressure (mirroring `place`, which multiplies it in at plot time). A
  // natively variable-pressure generator (raster `pressurehatch`) then reads as tonal weight; the
  // usual flat-pressure generator just weights uniformly. Multi-pen types (clip) carry per-member
  // pressure already, so they pass gain 1 and per-stroke pen colours.
  const gain = multiPen ? 1 : element.pressure ?? 1

  // After a resize bakes a new box into params, the cached ink is still fit to the OLD box until the
  // re-trace lands. Rescale just the strokes (not the underlay, which is already at the new size) so
  // they track the handles instead of flashing the old size. 1×1 for everything else.
  const prov = provisionalScale(element.id, element.type, element.params)

  // Dim the ink when it's stale (params edited but not regenerated yet) — a conspicuous "this isn't
  // current" cue right on the canvas. While generating (status present) we keep full opacity so the
  // lines streaming in read clearly.
  const generating = useGeneration((s) => !!s.status[element.id])
  const dirty = !generating && needsManualRegen(element.id, element.type, element.params)

  // Double-click/tap (the click already selected the element): on desktop a Logo program opens
  // its code editor. On mobile any element opens the inspector drawer instead — there's no
  // always-visible inspector there, and the code editor sits behind its Edit code button.
  const onDblClick = () => {
    if (isMobileViewport()) useUI.getState().setInspectorOpen(true)
    else if (element.type === 'logo') useUI.getState().setCodeDockFor(element.id)
  }

  return (
    <Group
      id={element.id}
      x={t.x}
      y={t.y}
      rotation={t.rotation}
      scaleX={t.scaleX}
      scaleY={t.scaleY}
      opacity={readOnly ? 1 : interactive ? (dirty ? 0.4 : 1) : 0.18}
      listening={!readOnly && interactive}
      draggable={!readOnly && interactive}
      {...(readOnly ? {} : handlers)}
      {...(interactive && !readOnly ? { onDblClick, onDblTap: onDblClick } : {})}
    >
      <BoxBounds element={element} />
      {element.type === 'raster' && <RasterUnderlay element={element} />}
      {/* Inner group carries the provisional resize scale for stale ink (1×1 normally). With
          strokeScaleEnabled false on the Lines, this scales positions but never pen width. */}
      <Group scaleX={prov.sx} scaleY={prov.sy}>
        <InkStrokes
          geom={geom}
          pxPerMm={pxPerMm}
          colorFor={colorFor}
          fixedColor={multiPen ? undefined : elementColor}
          pressureOn={pressureOn}
          gain={gain}
          dash={element.dash}
        />
      </Group>
    </Group>
  )
}

/** Memoized so an unrelated store change (another element edited, an async geometry bump elsewhere)
 *  doesn't re-render every element. Re-renders only when this element's ref / zoom / interactivity
 *  changes — which now happens precisely (transform-only edits and worker geometry both bump just
 *  this element's ref). */
export const ElementNode = memo(ElementNodeImpl)

/** An invisible rect at the physical box of any type that declares a `provisionalExtent` (raster,
 *  model), so the element's bounds (and thus the selection Transformer) stay consistent even
 *  when it has no strokes yet — without it the Group would collapse to 0×0 and become
 *  un-resizable. `listening={false}` keeps click selection strokes-only (no new hit area). */
function BoxBounds({ element }: { element: DocElement }) {
  const ext = getProvisionalExtent(element.type, element.params)
  if (!ext || ext.w <= 0 || ext.h <= 0) return null
  return <Rect x={0} y={0} width={ext.w} height={ext.h} listening={false} />
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
