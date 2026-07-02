// Per-type inspectors for the vector shapes: rect / ellipse / polygon / path.
import { useState } from 'react'
import { Link2, Ungroup } from 'lucide-react'
import { useDoc } from '../../store/document'
import { Button, Field, SectionTitle } from '../primitives'
import { Num, numFieldClass } from './controls'
import { HatchControls } from './hatch'
import type { RectParams, EllipseParams, PolygonParams, PathParams } from '../../elements/shapes'

export function RectInspector({ id, params }: { id: string; params: RectParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<RectParams>) => setParams(id, { ...params, ...patch })
  return (
    <>
      <SectionTitle>Rectangle</SectionTitle>
      <Num label="Width (mm)" value={params.w} step={1} onChange={(v) => up({ w: Math.max(0, v) })} />
      <Num label="Height (mm)" value={params.h} step={1} onChange={(v) => up({ h: Math.max(0, v) })} />
      <Num label="Corner radius (mm)" value={params.cornerRadius} step={1}
        onChange={(v) => up({ cornerRadius: Math.max(0, v) })} />
      <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
    </>
  )
}

export function EllipseInspector({ id, params }: { id: string; params: EllipseParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<EllipseParams>) => setParams(id, { ...params, ...patch })
  return (
    <>
      <SectionTitle>Ellipse</SectionTitle>
      <Num label="Radius X (mm)" value={params.rx} step={1} onChange={(v) => up({ rx: Math.max(0, v) })} />
      <Num label="Radius Y (mm)" value={params.ry} step={1} onChange={(v) => up({ ry: Math.max(0, v) })} />
      <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
    </>
  )
}

export function PolygonInspector({ id, params }: { id: string; params: PolygonParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<PolygonParams>) => setParams(id, { ...params, ...patch })
  return (
    <>
      <SectionTitle>{params.star ? 'Star' : 'Polygon'}</SectionTitle>
      <Num label={params.star ? 'Points' : 'Sides'} value={params.sides} step={1}
        onChange={(v) => up({ sides: Math.max(3, Math.round(v)) })} />
      <Num label="Radius X (mm)" value={params.rx} step={1} onChange={(v) => up({ rx: Math.max(0, v) })} />
      <Num label="Radius Y (mm)" value={params.ry} step={1} onChange={(v) => up({ ry: Math.max(0, v) })} />
      <Field label="Star" title="Alternate the radius in and out to make a star.">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={params.star}
          onChange={(e) => up({ star: e.target.checked })}
        />
      </Field>
      {params.star && (
        <Num label="Inner ratio" value={params.innerRatio} step={0.05}
          onChange={(v) => up({ innerRatio: Math.min(0.95, Math.max(0.05, v)) })} />
      )}
      <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
    </>
  )
}

export function PathInspector({ id, params }: { id: string; params: PathParams }) {
  const setParams = useDoc((s) => s.setParams)
  const simplifySelected = useDoc((s) => s.simplifySelected)
  const weldSelected = useDoc((s) => s.weldSelected)
  const breakApartSelected = useDoc((s) => s.breakApartSelected)
  const [tol, setTol] = useState('0.3')
  const nodeCount = params.contours.reduce((a, c) => a + c.nodes.length, 0)
  const anyClosed = params.contours.some((c) => c.closed)
  const allClosed = params.contours.length > 0 && params.contours.every((c) => c.closed)
  // Weldable only when there are multiple contours and at least one open end to chain.
  const hasOpenContour = params.contours.length > 1 && params.contours.some((c) => !c.closed)
  return (
    <>
      <SectionTitle>Path</SectionTitle>
      <Field label="Closed">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={allClosed}
          onChange={(e) =>
            setParams(id, {
              ...params,
              contours: params.contours.map((c) => ({ ...c, closed: e.target.checked })),
            })
          }
        />
      </Field>
      <p className="note text-xs text-muted">
        {params.contours.length > 1 ? `${params.contours.length} contours · ` : ''}
        {nodeCount} node{nodeCount === 1 ? '' : 's'} · drag points & handles on the canvas to edit.
      </p>
      {/* Path actions in a single 2-col grid so the buttons line up. */}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <div className="flex items-center gap-1.5">
          <input
            className={numFieldClass}
            value={tol}
            inputMode="decimal"
            title="Simplify tolerance in mm — higher removes more nodes"
            onChange={(e) => setTol(e.target.value)}
          />
          <span className="text-xs text-muted">mm</span>
        </div>
        <Button
          title="Reduce node count with Ramer–Douglas–Peucker"
          onClick={() => {
            const t = parseFloat(tol)
            if (Number.isFinite(t) && t > 0) simplifySelected(t)
          }}
        >
          Simplify
        </Button>
        {hasOpenContour && (
          <Button
            title="Weld open contours that share endpoints into single contours (loops close, so they can fill)"
            onClick={() => weldSelected()}
          >
            <Link2 size={15} /> Merge
          </Button>
        )}
        {params.contours.length > 1 && (
          <Button
            className={hasOpenContour ? '' : 'col-span-2'}
            title="Break this compound path into one path per contour"
            onClick={() => breakApartSelected()}
          >
            <Ungroup size={15} /> Break apart
          </Button>
        )}
      </div>
      {anyClosed && (
        <HatchControls
          hatch={params.hatch}
          onChange={(h) => setParams(id, { ...params, hatch: h })}
        />
      )}
    </>
  )
}
