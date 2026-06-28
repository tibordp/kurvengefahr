// Options dialog for SVG import. The geometry (parse, flatten, occlusion) runs in Rust; this only
// gathers options and shows a live shape count. Opened by DocumentMenu (which stashes the picked
// bytes in the svgImport store); mounted once in App.
import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Field, SectionTitle, controlClass } from './primitives'
import { useSvgImport } from '../store/svgImport'
import { importSvgRaw } from '../core/wasm/shapes'
import {
  addSvgElements,
  defaultSvgImportOptions,
  svgIsPhysical,
  USVG_DPI,
  MM_PER_IN,
  type SvgImportOptions,
} from '../canvas/importSvg'
import type { HatchPattern } from '../elements/shapes'

function NumberField({
  value,
  onChange,
  min = 0,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
}) {
  // Display at 2 decimals (e.g. an SVG's native mm size), full precision still stored on edit.
  const fmt = (v: number) => String(Number(v.toFixed(2)))
  const [text, setText] = useState(() => fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  return (
    <input
      className={controlClass}
      value={text}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value)
        const v = parseFloat(e.target.value)
        if (Number.isFinite(v) && v >= min) onChange(v)
      }}
    />
  )
}

const Check = ({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) => (
  <Field label={label}>
    <input
      type="checkbox"
      className="h-4 w-4 justify-self-start"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  </Field>
)

export function SvgImportDialog() {
  const pending = useSvgImport((s) => s.pending)
  const close = useSvgImport((s) => s.close)
  const [opts, setOpts] = useState<SvgImportOptions>(defaultSvgImportOptions)
  const set = (patch: Partial<SvgImportOptions>) => setOpts((o) => ({ ...o, ...patch }))
  const [scaleMode, setScaleMode] = useState<'fit' | 'actual'>('fit')
  const [dpi, setDpi] = useState(96)

  // A physical SVG (width in mm/cm/in/…) can import truly 1:1; a pixel one needs a DPI to size it.
  const physical = useMemo(() => (pending ? svgIsPhysical(pending.bytes) : false), [pending])
  useEffect(() => {
    if (pending) setScaleMode(svgIsPhysical(pending.bytes) ? 'actual' : 'fit')
  }, [pending])

  const pxToMm =
    scaleMode === 'actual' ? (physical ? MM_PER_IN / USVG_DPI : MM_PER_IN / Math.max(1, dpi)) : 0

  // Parse once for the count + real size; cheap enough to redo as options change.
  const preview = useMemo(() => {
    if (!pending) return null
    try {
      return importSvgRaw(pending.bytes, opts.occlude, opts.targetSize, pxToMm)
    } catch {
      return null
    }
  }, [pending, opts.occlude, opts.targetSize, pxToMm])
  const count = preview?.length ?? 0
  const size = useMemo(() => {
    if (!preview?.length) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of preview)
      for (const r of s.rings)
        for (const p of r.points) {
          if (p.x < x0) x0 = p.x
          if (p.y < y0) y0 = p.y
          if (p.x > x1) x1 = p.x
          if (p.y > y1) y1 = p.y
        }
    return { w: x1 - x0, h: y1 - y0 }
  }, [preview])

  if (!pending) return null

  const filled = opts.fillStyle !== 'none'
  const onImport = () => {
    addSvgElements(pending.bytes, { ...opts, pxToMm, groupName: pending.name.replace(/\.svg$/i, '') })
    close()
  }

  return (
    <Modal title={`Import ${pending.name}`} onClose={close} className="w-[26rem]">
      <SectionTitle>Placement</SectionTitle>
      <Field label="Scale">
        <select className={controlClass} value={scaleMode} onChange={(e) => setScaleMode(e.target.value as 'fit' | 'actual')}>
          <option value="fit">Fit to size</option>
          <option value="actual">Actual size (1:1)</option>
        </select>
      </Field>
      {scaleMode === 'fit' && (
        <Field label="Size — longest side (mm)">
          <NumberField value={opts.targetSize} min={1} onChange={(v) => set({ targetSize: v })} />
        </Field>
      )}
      {scaleMode === 'actual' && !physical && (
        <Field label="Resolution (DPI)">
          <NumberField value={dpi} min={1} onChange={setDpi} />
        </Field>
      )}
      {scaleMode === 'actual' && physical && (
        <p className="text-xs text-muted">Physical units detected — imported 1:1.</p>
      )}
      <Check
        label="Occlude hidden parts"
        checked={opts.occlude}
        onChange={(v) => set({ occlude: v })}
      />
      <Check
        label="Map colours to pens"
        checked={opts.colorToPen}
        onChange={(v) => set({ colorToPen: v })}
      />

      <SectionTitle>Fills</SectionTitle>
      <Field label="Fill style">
        <select
          className={controlClass}
          value={opts.fillStyle}
          onChange={(e) => set({ fillStyle: e.target.value as HatchPattern })}
        >
          <option value="none">Outline only</option>
          <option value="lines">Lines</option>
          <option value="cross">Cross-hatch</option>
          <option value="grid">Grid</option>
          <option value="concentric">Concentric</option>
          <option value="hilbert">Hilbert curve</option>
        </select>
      </Field>
      {filled && (
        <>
          <Field label="Density — darkest spacing (mm)">
            <NumberField value={opts.density} min={0.3} onChange={(v) => set({ density: v })} />
          </Field>
          <Check
            label="Density from fill darkness"
            checked={opts.mapDensity}
            onChange={(v) => set({ mapDensity: v })}
          />
        </>
      )}

      <p className="mt-3 text-xs text-muted">
        {count > 0
          ? `${count} shape${count === 1 ? '' : 's'}${size ? ` · ${size.w.toFixed(1)} × ${size.h.toFixed(1)} mm` : ''}`
          : 'No shapes found.'}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onImport} disabled={count === 0}>
          Import
        </Button>
      </div>
    </Modal>
  )
}
