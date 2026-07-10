// Export the design to a portable format. SVG is vector (per-pen layers); PDF is vector on a
// bed-sized page; PNG is raster at a chosen resolution. Print… proofs at true physical scale.
// Opened from the document menu, mounted once in App.
import { useState } from 'react'
import { Modal, Button, Field, controlClass } from './primitives'
import { useExportDialog } from '../store/exportDialog'
import { exportSvg, exportPng } from '../output/exportVector'
import { exportPdf } from '../output/exportPdf'
import { printDocument } from '../output/print'

type Format = 'svg' | 'pdf' | 'png'

export function ExportDialog() {
  const open = useExportDialog((s) => s.open)
  const close = () => useExportDialog.getState().set(false)
  const [format, setFormat] = useState<Format>('svg')
  const [dpmm, setDpmm] = useState('8') // PNG pixels per mm

  if (!open) return null

  const onExport = () => {
    if (format === 'svg') exportSvg()
    else if (format === 'pdf') exportPdf()
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
          <option value="pdf">PDF — vector, page at bed size</option>
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
      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="ghost"
          title="Print at true physical scale (a paper proof before plotting)"
          onClick={() => {
            printDocument()
            close()
          }}
        >
          Print…
        </Button>
        <div className="flex-1" />
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
