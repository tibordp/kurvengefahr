import { useState } from 'react'
import { useDoc } from '../store/document'
import { usePreview } from '../store/preview'
import { runPipeline, buildPlottableGeometry } from '../core/pipeline'
import { optimizeGeometry } from '../core/pipeline/optimize'
import { penParkInPage } from '../core/pipeline/toMachine'
import { buildToolpath } from '../core/preview/toolpath'
import { downloadSink } from '../output/sink'

export function Toolbar() {
  const addHandwriting = useDoc((s) => s.addHandwriting)
  const previewActive = usePreview((s) => s.active)
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const togglePreview = async () => {
    if (previewActive) {
      usePreview.getState().exit()
      return
    }
    const { elements, profile } = useDoc.getState()
    if (elements.length === 0) return
    setPreparing(true)
    try {
      // Seed both the optimizer and the preview's first travel from the pen's real park
      // point (machine origin in page space), so the dotted line starts at the right corner.
      const park = penParkInPage(profile)
      const plottable = buildPlottableGeometry(elements, profile)
      const optimized = await optimizeGeometry(plottable, park)
      usePreview.getState().enter(buildToolpath(optimized, park))
    } finally {
      setPreparing(false)
    }
  }

  const onGenerate = async () => {
    const { elements, profile } = useDoc.getState()
    if (elements.length === 0) return
    setBusy(true)
    try {
      const gcode = await runPipeline(elements, profile)
      await downloadSink.send('kurvengefahr.gcode', gcode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="toolbar">
      <span className="brand">Kurvengefahr</span>
      <button onClick={() => addHandwriting()} disabled={previewActive}>
        + Handwriting
      </button>

      <span className="spacer" />

      <button onClick={togglePreview} disabled={preparing}>
        {previewActive ? '✎ Edit' : preparing ? 'Preparing…' : '▶ Preview'}
      </button>
      <button className="primary" onClick={onGenerate} disabled={busy}>
        {busy ? 'Generating…' : 'Generate G-code'}
      </button>
    </div>
  )
}
