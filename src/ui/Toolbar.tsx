import { useState } from 'react'
import { RotateCw, Play, Pencil, Download, PanelRight } from 'lucide-react'
import { useDoc } from '../store/document'
import { usePreview } from '../store/preview'
import { useUI } from '../store/ui'
import { regenerateAll, isElementDirty } from '../core/generation'
import { runPipeline, buildPlottableGeometry } from '../core/pipeline'
import { optimizeGeometry } from '../core/pipeline/optimize'
import { penParkInPage } from '../core/pipeline/toMachine'
import { buildToolpath } from '../core/preview/toolpath'
import { downloadSink } from '../output/sink'
import { Button, IconButton } from './primitives'
import { DocumentMenu } from './DocumentMenu'

/** A curving trail with a gap + head — a nod to "Achtung, die Kurve!" (and to drawing one
 *  continuous line). `currentColor`, so it inherits the accent. */
function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" className={className} aria-hidden>
      <path
        d="M3 18C6.5 18 6 8 11 8"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M14.5 8C19 8 18 17 21 17"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="21" cy="17" r="1.9" fill="currentColor" />
    </svg>
  )
}

export function Toolbar() {
  const elements = useDoc((s) => s.elements)
  const previewActive = usePreview((s) => s.active)
  const toggleInspector = useUI((s) => s.toggleInspector)
  const [busy, setBusy] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const dirtyCount = elements.filter((e) => isElementDirty(e.id, e.type, e.params)).length

  const togglePreview = async () => {
    if (previewActive) {
      usePreview.getState().exit()
      return
    }
    const { elements, profile, fiducial } = useDoc.getState()
    if (elements.length === 0) return
    setPreparing(true)
    try {
      // Seed both the optimizer and the preview's first travel from the pen's real park
      // point (machine origin in page space), so the dotted line starts at the right corner.
      const park = penParkInPage(profile)
      const plottable = buildPlottableGeometry(elements, profile)
      const optimized = await optimizeGeometry(plottable, park, profile.pens.map((p) => p.id))
      usePreview.getState().enter(buildToolpath(optimized, park, fiducial))
    } finally {
      setPreparing(false)
    }
  }

  const onGenerate = async () => {
    const { elements, profile, fiducial } = useDoc.getState()
    if (elements.length === 0) return
    setBusy(true)
    try {
      const gcode = await runPipeline(elements, profile, [], fiducial)
      await downloadSink.send('kurvengefahr.gcode', gcode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <header className="col-span-full flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <LogoMark className="text-accent" />
        <span className="hidden text-[15px] font-semibold tracking-tight lg:inline">
          Kurvengefahr
        </span>
      </div>

      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <DocumentMenu />
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />

      {/* Regenerate edited (dirty) elements */}
      {dirtyCount > 0 && !previewActive && (
        <Button
          variant="warn"
          onClick={() => regenerateAll()}
          title={`Regenerate ${dirtyCount} edited element(s)`}
          aria-label={`Regenerate ${dirtyCount} edited elements`}
        >
          <RotateCw size={15} />
          <span className="hidden sm:inline">Regenerate</span> ({dirtyCount})
        </Button>
      )}

      <span className="flex-1" />

      {/* Output */}
      <Button onClick={togglePreview} disabled={preparing} title={previewActive ? 'Edit' : 'Preview'}>
        {previewActive ? <Pencil size={15} /> : <Play size={15} />}
        <span className="hidden sm:inline">
          {previewActive ? 'Edit' : preparing ? 'Preparing…' : 'Preview'}
        </span>
      </Button>
      <Button
        variant="primary"
        onClick={onGenerate}
        disabled={busy}
        aria-label="Generate G-code"
        title="Generate G-code"
      >
        <Download size={15} />
        <span className="hidden sm:inline">{busy ? 'Generating…' : 'Generate G-code'}</span>
      </Button>

      {/* Inspector toggle — mobile only (drawer). */}
      <IconButton
        className="md:hidden"
        onClick={toggleInspector}
        aria-label="Toggle inspector"
        title="Toggle inspector"
      >
        <PanelRight size={17} />
      </IconButton>
    </header>
  )
}
