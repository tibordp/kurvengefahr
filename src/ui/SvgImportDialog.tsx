// Options dialog for SVG import. The geometry (parse, flatten, occlusion) runs in Rust; this only
// gathers options and shows a live shape count. Opened by DocumentMenu (which stashes the picked
// bytes in the svgImport store); mounted once in App.
import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, Field, SectionTitle, controlClass } from './primitives'
import { useSvgImport } from '../store/svgImport'
import { importSvgRaw } from '../core/wasm/shapes'
import { addSvgElements, defaultSvgImportOptions, type SvgImportOptions } from '../canvas/importSvg'
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

  // Shape count is independent of scale, so only occlusion changes it — keep size typing snappy.
  const count = useMemo(() => {
    if (!pending) return 0
    try {
      return importSvgRaw(pending.bytes, opts.occlude, 100).length
    } catch {
      return 0
    }
  }, [pending, opts.occlude])

  if (!pending) return null

  const filled = opts.fillStyle !== 'none'
  const onImport = () => {
    addSvgElements(pending.bytes, { ...opts, groupName: pending.name.replace(/\.svg$/i, '') })
    close()
  }

  return (
    <Modal title={`Import ${pending.name}`} onClose={close} className="w-[26rem]">
      <SectionTitle>Placement</SectionTitle>
      <Field label="Size — longest side (mm)">
        <NumberField value={opts.targetSize} min={1} onChange={(v) => set({ targetSize: v })} />
      </Field>
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
        {count > 0 ? `${count} shape${count === 1 ? '' : 's'} will be imported.` : 'No shapes found.'}
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
