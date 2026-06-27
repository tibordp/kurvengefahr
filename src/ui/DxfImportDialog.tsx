// Options dialog for DXF import. Parsing + curve flattening + segment merging run in Rust; this only
// gathers options and shows a live path count + the real imported size. DXF carries real dimensions,
// so we import at actual size with a unit selector (defaulted from the file's $INSUNITS, overridable
// for files that lie or omit it). Opened by importFile (stashes the bytes in the dxfImport store).
import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Field, SectionTitle, controlClass } from './primitives'
import { useDxfImport } from '../store/dxfImport'
import { importDxfRaw } from '../core/wasm/shapes'
import {
  addDxfElements,
  DXF_UNITS,
  unitFromInsunits,
  unitScaleFor,
  type DxfUnit,
} from '../canvas/importDxf'

const Check = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) => (
  <Field label={label}>
    <input
      type="checkbox"
      className="h-4 w-4 justify-self-start"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  </Field>
)

export function DxfImportDialog() {
  const pending = useDxfImport((s) => s.pending)
  const close = useDxfImport((s) => s.close)
  const [merge, setMerge] = useState(true)
  const [colorToPen, setColorToPen] = useState(true)
  const [unit, setUnit] = useState<DxfUnit>('mm')

  // Parse once per file at unit 1 to read $INSUNITS, then default the unit selector to it.
  useEffect(() => {
    if (!pending) return
    setMerge(true)
    try {
      setUnit(unitFromInsunits(importDxfRaw(pending.bytes, 1, false).insunits))
    } catch {
      setUnit('mm')
    }
  }, [pending])

  // Geometry at unit 1; count depends only on merging, the bbox lets us show the real size.
  const parsed = useMemo(() => (pending ? importDxfRaw(pending.bytes, 1, merge) : null), [pending, merge])
  const count = parsed?.shapes.length ?? 0
  const size = useMemo(() => {
    if (!parsed?.shapes.length) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of parsed.shapes)
      for (const r of s.rings)
        for (const p of r.points) {
          if (p.x < x0) x0 = p.x
          if (p.y < y0) y0 = p.y
          if (p.x > x1) x1 = p.x
          if (p.y > y1) y1 = p.y
        }
    const f = unitScaleFor(unit)
    return { w: (x1 - x0) * f, h: (y1 - y0) * f }
  }, [parsed, unit])

  if (!pending) return null

  const onImport = () => {
    addDxfElements(pending.bytes, {
      unitScale: unitScaleFor(unit),
      colorToPen,
      merge,
      groupName: pending.name.replace(/\.dxf$/i, ''),
    })
    close()
  }

  return (
    <Modal title={`Import ${pending.name}`} onClose={close} className="w-[26rem]">
      <SectionTitle>Units &amp; placement</SectionTitle>
      <Field label="Unit (imported at actual size)">
        <select className={controlClass} value={unit} onChange={(e) => setUnit(e.target.value as DxfUnit)}>
          {DXF_UNITS.map((u) => (
            <option key={u.key} value={u.key}>
              {u.label}
            </option>
          ))}
        </select>
      </Field>
      <Check label="Merge connected segments" checked={merge} onChange={setMerge} />
      <Check label="Map colours to pens" checked={colorToPen} onChange={setColorToPen} />

      <p className="mt-3 text-xs text-muted">
        {count > 0
          ? `${count} path${count === 1 ? '' : 's'}${size ? ` · ${size.w.toFixed(1)} × ${size.h.toFixed(1)} mm` : ''}`
          : 'No supported entities found.'}
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
