// The Elements-tab body: single-selection element editor, multi-select actions, and the fiducial.
import {
  Trash2,
  Eye,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Spline,
  Link2,
  FlipHorizontal,
  FlipVertical,
} from 'lucide-react'
import { useDoc, type AlignEdge } from '../../store/document'
import { isMultiPen } from '../../elements/registry'
import { drawableRegion } from '../../core/pipeline/clip'
import { pressureEnabled } from '../../core/types'
import type { HandwritingParams } from '../../elements/handwriting'
import type { LogoParams } from '../../elements/logo'
import type { RasterParams } from '../../elements/raster'
import type { TextParams } from '../../elements/text'
import type { GenerativeParams } from '../../elements/generative'
import type { RectParams, EllipseParams, PolygonParams, PathParams } from '../../elements/shapes'
import { Button, IconButton, Field, SectionTitle, Banner } from '../primitives'
import { MOD_KEY } from '../shortcuts'
import { Num, SliderNum, PenSelect } from './controls'
import { EffectsSection } from './EffectsSection'
import {
  RectInspector,
  EllipseInspector,
  PolygonInspector,
  PathInspector,
} from './shapeInspectors'
import {
  HandwritingInspector,
  TextInspector,
  GenerativeInspector,
  RasterInspector,
  LogoInspector,
} from './contentInspectors'

/** Shown when 2+ elements are selected: align + group actions. */
function MultiSelectSection({ count }: { count: number }) {
  const align = useDoc((s) => s.align)
  const removeSelected = useDoc((s) => s.removeSelected)
  const duplicateSelected = useDoc((s) => s.duplicateSelected)
  const setPenSelected = useDoc((s) => s.setPenSelected)
  const setPressureSelected = useDoc((s) => s.setPressureSelected)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const booleanSelected = useDoc((s) => s.booleanSelected)
  const joinSelected = useDoc((s) => s.joinSelected)
  const convertToPath = useDoc((s) => s.convertToPath)
  const simplifySelected = useDoc((s) => s.simplifySelected)
  const nonPathCount = useDoc(
    (s) => s.elements.filter((e) => s.selectedIds.includes(e.id) && e.type !== 'path').length,
  )
  const pathCount = useDoc(
    (s) => s.elements.filter((e) => s.selectedIds.includes(e.id) && e.type === 'path').length,
  )
  // How many selected elements are closed shapes (rect/ellipse/closed path) — boolean ops need ≥2.
  const closedCount = useDoc(
    (s) =>
      s.elements.filter((e) => {
        if (!s.selectedIds.includes(e.id)) return false
        if (e.type === 'rect' || e.type === 'ellipse') return true
        if (e.type === 'path')
          return (e.params as PathParams).contours.some((c) => c.closed && c.nodes.length >= 3)
        return false
      }).length,
  )
  // The shared pen of the selection, or null when they differ (→ "Mixed"). Single-pen elements
  // only; a natively multi-colour element in the mix is ignored for this control.
  const commonPen = useDoc((s) => {
    const sel = s.elements.filter((e) => s.selectedIds.includes(e.id) && !isMultiPen(e.type))
    if (!sel.length) return null
    return sel.every((e) => e.pen === sel[0].pen) ? sel[0].pen : null
  })
  // Shared pressure of the (single-pen) selection, or null when they differ.
  const commonPressure = useDoc((s) => {
    const sel = s.elements.filter((e) => s.selectedIds.includes(e.id) && !isMultiPen(e.type))
    if (!sel.length) return null
    const first = sel[0].pressure ?? 1
    return sel.every((e) => (e.pressure ?? 1) === first) ? first : null
  })
  const A = ({ edge, Icon, title }: { edge: AlignEdge; Icon: typeof AlignStartVertical; title: string }) => (
    <IconButton aria-label={title} title={title} onClick={() => align(edge)}>
      <Icon size={16} />
    </IconButton>
  )
  return (
    <>
      <SectionTitle>{count} selected</SectionTitle>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <A edge="left" Icon={AlignStartVertical} title="Align left" />
        <A edge="centerX" Icon={AlignCenterVertical} title="Align centre (horizontal)" />
        <A edge="right" Icon={AlignEndVertical} title="Align right" />
        <span className="mx-1 h-5 w-px bg-border" />
        <A edge="top" Icon={AlignStartHorizontal} title="Align top" />
        <A edge="centerY" Icon={AlignCenterHorizontal} title="Align middle (vertical)" />
        <A edge="bottom" Icon={AlignEndHorizontal} title="Align bottom" />
      </div>
      {closedCount >= 2 && (
        <div className="mt-3">
          <SectionTitle>Combine shapes</SectionTitle>
          <div className="grid grid-cols-2 gap-1">
            <Button title="Union — merge into one shape" onClick={() => booleanSelected(0)}>
              Union
            </Button>
            <Button title="Subtract — remove the upper shapes from the bottom one" onClick={() => booleanSelected(2)}>
              Subtract
            </Button>
            <Button title="Intersect — keep only the overlap" onClick={() => booleanSelected(1)}>
              Intersect
            </Button>
            <Button title="Exclude — keep the non-overlapping parts" onClick={() => booleanSelected(3)}>
              Exclude
            </Button>
          </div>
        </div>
      )}
      {(nonPathCount > 0 || pathCount > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-1">
          {nonPathCount > 0 && (
            <Button
              className={pathCount > 0 ? '' : 'col-span-2'}
              title="Convert the non-path elements in the selection into editable paths"
              onClick={() => convertToPath()}
            >
              <Spline size={15} /> To path
            </Button>
          )}
          {pathCount > 0 && (
            <Button
              className={nonPathCount > 0 ? '' : 'col-span-2'}
              title="Simplify selected paths (Ramer–Douglas–Peucker, 0.3 mm)"
              onClick={() => simplifySelected(0.3)}
            >
              Simplify
            </Button>
          )}
        </div>
      )}
      <Button
        className="mt-1 w-full"
        title="Combine into one compound path — keeps curves and open paths; overlaps become holes (use Union to merge areas instead)."
        onClick={() => joinSelected()}
      >
        <Link2 size={15} /> Combine
      </Button>
      <div className="mt-3">
        <PenSelect value={commonPen} onChange={(pen) => setPenSelected(pen)} />
        {commonPen !== null && (
          <SliderNum
            label="Pressure (%)"
            title={pressureOn ? 'Pen pressure, light to full.' : 'Machine has no variable pressure.'}
            min={0}
            max={100}
            step={1}
            int
            hardMax
            disabled={!pressureOn}
            value={Math.round((commonPressure ?? 1) * 100)}
            onChange={(v) => setPressureSelected(v / 100)}
          />
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button className="flex-1" title={`Duplicate (${MOD_KEY}D)`} onClick={() => duplicateSelected()}>
          Duplicate
        </Button>
        <Button variant="danger" title="Delete (Del)" onClick={() => removeSelected()}>
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </>
  )
}

/** The document fiducial (alignment point), if placed. Document-level, not an element — so it has
 *  its own editor rather than living in the selection-driven element UI. */
export function FiducialSection() {
  const fiducial = useDoc((s) => s.fiducial)
  const setFiducial = useDoc((s) => s.setFiducial)
  const profile = useDoc((s) => s.profile)
  if (!fiducial) return null

  const r = drawableRegion(profile)
  const outOfReach = fiducial.x < r.x0 || fiducial.x > r.x1 || fiducial.y < r.y0 || fiducial.y > r.y1

  return (
    <>
      <SectionTitle title="Alignment point. At the start of a print the pen travels here at a high Z and pauses (M0) so you can register the medium before drawing.">
        Fiducial
      </SectionTitle>
      {outOfReach && (
        <Banner variant="warn">⚠ Outside the pen's reachable area — it may not be plottable.</Banner>
      )}
      <Num label="X (mm)" value={fiducial.x} step={1} onChange={(v) => setFiducial({ ...fiducial, x: v })} />
      <Num label="Y (mm)" value={fiducial.y} step={1} onChange={(v) => setFiducial({ ...fiducial, y: v })} />
      <Button variant="danger" className="mt-2 w-full" onClick={() => setFiducial(null)}>
        <Trash2 size={15} /> Remove fiducial
      </Button>
    </>
  )
}

export function ElementSection() {
  const selectedIds = useDoc((s) => s.selectedIds)
  const element = useDoc((s) =>
    s.selectedIds.length === 1 ? (s.elements.find((e) => e.id === s.selectedIds[0]) ?? null) : null,
  )
  const setTransform = useDoc((s) => s.setTransform)
  const setPen = useDoc((s) => s.setPen)
  const setDash = useDoc((s) => s.setDash)
  const setPressure = useDoc((s) => s.setPressure)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const removeElement = useDoc((s) => s.removeElement)
  const convertToPath = useDoc((s) => s.convertToPath)
  const flipSelected = useDoc((s) => s.flipSelected)

  if (selectedIds.length === 0) {
    return (
      <div className="mt-6 flex flex-col items-center gap-2 px-4 text-center">
        <Eye size={22} className="text-faint" />
        <p className="text-xs text-muted">
          Nothing selected. Pick a tool to draw, or click an element to edit. Shift-click or drag a
          marquee to select several.
        </p>
      </div>
    )
  }

  if (selectedIds.length > 1) return <MultiSelectSection count={selectedIds.length} />
  if (!element) return null

  const t = element.transform
  return (
    <>
      {element.type === 'handwriting' && (
        <HandwritingInspector id={element.id} params={element.params as HandwritingParams} />
      )}
      {element.type === 'rect' && <RectInspector id={element.id} params={element.params as RectParams} />}
      {element.type === 'ellipse' && (
        <EllipseInspector id={element.id} params={element.params as EllipseParams} />
      )}
      {element.type === 'polygon' && (
        <PolygonInspector id={element.id} params={element.params as PolygonParams} />
      )}
      {element.type === 'text' && <TextInspector id={element.id} params={element.params as TextParams} />}
      {element.type === 'generative' && (
        <GenerativeInspector id={element.id} params={element.params as GenerativeParams} />
      )}
      {element.type === 'path' && <PathInspector id={element.id} params={element.params as PathParams} />}
      {element.type === 'raster' && <RasterInspector id={element.id} params={element.params as RasterParams} />}
      {element.type === 'logo' && <LogoInspector id={element.id} params={element.params as LogoParams} />}

      {element.type !== 'path' && (
        <Button
          className="mt-3 w-full"
          title="Convert this element into editable path(s) you can node-edit"
          onClick={() => convertToPath([element.id])}
        >
          <Spline size={15} /> Convert to path
        </Button>
      )}

      {!isMultiPen(element.type) && (
        <>
          <SectionTitle>Pen</SectionTitle>
          <PenSelect value={element.pen} onChange={(pen) => setPen(element.id, pen)} />
        </>
      )}

      {/* Pen pressure + dashed style are per-stroke properties — meaningless on a container (its
          members carry their own), so the whole Stroke section is hidden for multi-pen types. */}
      {!isMultiPen(element.type) && (
        <>
          <SectionTitle>Stroke</SectionTitle>
          <SliderNum
            label="Pressure (%)"
            title={pressureOn ? 'Pen pressure, light to full.' : 'Machine has no variable pressure.'}
            min={0}
            max={100}
            step={1}
            int
            hardMax
            disabled={!pressureOn}
            value={Math.round((element.pressure ?? 1) * 100)}
            onChange={(v) => setPressure(element.id, v / 100)}
          />
          {!pressureOn && (
            <p className="-mt-1 mb-2 text-2xs text-faint">Machine has no variable pressure.</p>
          )}
          <Field label="Dashed">
            <input
              type="checkbox"
              className="h-4 w-4 justify-self-start"
              checked={!!element.dash}
              onChange={(e) => setDash(element.id, e.target.checked ? { dash: 2, gap: 2 } : null)}
            />
          </Field>
          {element.dash && (
            <>
              <Num label="Dash (mm)" value={element.dash.dash} step={0.5}
                onChange={(v) => setDash(element.id, { dash: Math.max(0.1, v), gap: element.dash!.gap })} />
              <Num label="Gap (mm)" value={element.dash.gap} step={0.5}
                onChange={(v) => setDash(element.id, { dash: element.dash!.dash, gap: Math.max(0.1, v) })} />
            </>
          )}
        </>
      )}

      <EffectsSection id={element.id} effects={element.effects ?? []} />

      <SectionTitle>Transform</SectionTitle>
      <Num label="X (mm)" value={t.x} step={1} onChange={(v) => setTransform(element.id, { x: v })} />
      <Num label="Y (mm)" value={t.y} step={1} onChange={(v) => setTransform(element.id, { y: v })} />
      <Num label="Rotation (°)" value={t.rotation} step={1}
        onChange={(v) => setTransform(element.id, { rotation: v })} />
      <Num label="Scale X" value={t.scaleX} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleX: v })} />
      <Num label="Scale Y" value={t.scaleY} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleY: v })} />
      <Field label="Flip">
        <div className="flex gap-1">
          <IconButton
            aria-label="Flip horizontal"
            title="Flip horizontal (Shift+H)"
            onClick={() => flipSelected('x')}
          >
            <FlipHorizontal size={16} />
          </IconButton>
          <IconButton
            aria-label="Flip vertical"
            title="Flip vertical (Shift+V)"
            onClick={() => flipSelected('y')}
          >
            <FlipVertical size={16} />
          </IconButton>
        </div>
      </Field>

      <div className="mt-3 flex gap-2">
        <Button
          className="flex-1"
          title="Reset position to a visible spot near the top-left of the bed"
          onClick={() => setTransform(element.id, { x: 20, y: 20 })}
        >
          Bring into view
        </Button>
        <Button variant="danger" title="Delete (Del)" onClick={() => removeElement(element.id)}>
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </>
  )
}
