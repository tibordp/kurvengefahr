// Options dialog for DXF import. Parsing + curve flattening + segment merging run in Rust; this only
// gathers options and shows a live element count. Opened by importFile (which stashes the picked
// bytes in the dxfImport store); mounted once in App.
import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Field, SectionTitle, controlClass } from './primitives'
import { useDxfImport } from '../store/dxfImport'
import { importDxfRaw } from '../core/wasm/shapes'
import { addDxfElements, defaultDxfImportOptions, type DxfImportOptions } from '../canvas/importDxf'

function NumberField({ value, onChange, min = 1 }: { value: number; onChange: (v: number) => void; min?: number }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
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
  const [opts, setOpts] = useState<DxfImportOptions>(defaultDxfImportOptions)
  const set = (patch: Partial<DxfImportOptions>) => setOpts((o) => ({ ...o, ...patch }))

  // Element count depends only on merging (scale doesn't change it) — keep size typing snappy.
  const count = useMemo(() => {
    if (!pending) return 0
    try {
      return importDxfRaw(pending.bytes, 100, opts.merge).length
    } catch {
      return 0
    }
  }, [pending, opts.merge])

  if (!pending) return null

  const onImport = () => {
    addDxfElements(pending.bytes, { ...opts, groupName: pending.name.replace(/\.dxf$/i, '') })
    close()
  }

  return (
    <Modal title={`Import ${pending.name}`} onClose={close} className="w-[26rem]">
      <SectionTitle>Placement</SectionTitle>
      <Field label="Size — longest side (mm)">
        <NumberField value={opts.targetSize} min={1} onChange={(v) => set({ targetSize: v })} />
      </Field>
      <Check
        label="Merge connected segments"
        checked={opts.merge}
        onChange={(v) => set({ merge: v })}
      />
      <Check label="Map colours to pens" checked={opts.colorToPen} onChange={(v) => set({ colorToPen: v })} />

      <p className="mt-3 text-xs text-muted">
        {count > 0 ? `${count} path${count === 1 ? '' : 's'} will be imported.` : 'No supported entities found.'}
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
