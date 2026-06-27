// Export the design to a portable format. SVG is vector (per-pen layers); PNG is raster at a chosen
// resolution. Opened from the document menu, mounted once in App.
import { useState } from 'react'
import { Modal, Button, Field, controlClass } from './primitives'
import { useExportDialog } from '../store/exportDialog'
import { exportSvg, exportPng } from '../output/exportVector'

type Format = 'svg' | 'png'

export function ExportDialog() {
  const open = useExportDialog((s) => s.open)
  const close = () => useExportDialog.getState().set(false)
  const [format, setFormat] = useState<Format>('svg')
  const [dpmm, setDpmm] = useState('8') // PNG pixels per mm

  if (!open) return null

  const onExport = () => {
    if (format === 'svg') exportSvg()
    else {
      const v = parseFloat(dpmm)
      void exportPng(Number.isFinite(v) && v > 0 ? v : undefined)
    }
    close()
  }

  return (
    <Modal title="Export" onClose={close} className="w-[24rem]">
      <Field label="Format">
        <select className={controlClass} value={format} onChange={(e) => setFormat(e.target.value as Format)}>
          <option value="svg">SVG — vector, per-pen layers</option>
          <option value="png">PNG — raster image</option>
        </select>
      </Field>
      {format === 'png' && (
        <Field label="Resolution (px/mm)" title="8 px/mm ≈ 200 dpi">
          <input
            className={controlClass}
            value={dpmm}
            inputMode="decimal"
            onChange={(e) => setDpmm(e.target.value)}
          />
        </Field>
      )}
      <p className="mt-2 text-xs text-muted">
        Exports the plottable geometry — exactly what the G-code is built from.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onExport}>
          Export
        </Button>
      </div>
    </Modal>
  )
}
