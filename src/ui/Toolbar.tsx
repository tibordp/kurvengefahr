import { useState } from 'react'
import { RotateCw, Play, Pencil, Download, Printer, PanelRight, CircleHelp, Undo2, Redo2 } from 'lucide-react'
import { useDoc } from '../store/document'
import { usePreview } from '../store/preview'
import { useTools } from '../store/tools'
import { useUI } from '../store/ui'
import { useHistory, undo, redo } from '../store/history'
import { regenerateAll, needsManualRegen } from '../core/generation'
import { validateProfile } from '../core/profileValidation'
import { buildPlottableGeometry } from '../core/pipeline'
import { optimizeGeometry } from '../core/pipeline/optimize'
import { penParkInPage } from '../core/pipeline/toMachine'
import { buildToolpath } from '../core/preview/toolpath'
import { exportGcode, plotGcode } from '../output/export'
import { BridgeError } from '../output/plot'
import { toast } from '../store/toast'
import { Button, IconButton } from './primitives'
import { MOD_KEY } from './shortcuts'
import { DocumentMenu } from './DocumentMenu'

/** Map a bridge failure to a short, human toast. CANCELLED is intentionally absent (silent). */
function plotErrorMessage(code: string): string {
  switch (code) {
    case 'DENIED': return 'Permission needed — allow access in the extension'
    case 'NOT_GRANTED':
    case 'NO_HOST_PERMISSION': return 'Reconnect the printer in Machine settings'
    case 'PRINTER_UNREACHABLE': return "Couldn't reach the printer"
    case 'AUTH_FAILED': return 'Printer rejected the credentials'
    case 'PRINTER_BUSY': return 'Printer is busy'
    case 'NOT_INSTALLED': return 'Plotter extension not found'
    case 'TIMEOUT': return 'Plot timed out'
    default: return 'Plot failed'
  }
}

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
  const toggleHelp = useUI((s) => s.toggleHelp)
  const canUndo = useHistory((s) => s.past.length > 0)
  const canRedo = useHistory((s) => s.future.length > 0)
  const device = useDoc((s) => s.profile.device)
  const profileInvalid = useDoc((s) => validateProfile(s.profile).length > 0)
  const [busy, setBusy] = useState(false)
  const [plotting, setPlotting] = useState(false)
  const [preparing, setPreparing] = useState(false)

  const dirtyCount = elements.filter((e) => needsManualRegen(e.id, e.type, e.params)).length

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
      // Preview is a read-only mode — disarm any drawing tool so the toolbar reflects it and exiting
      // doesn't drop you back into a half-armed tool.
      useTools.getState().setTool('select')
      usePreview.getState().enter(buildToolpath(optimized, park, fiducial))
    } finally {
      setPreparing(false)
    }
  }

  const onGenerate = async () => {
    if (elements.length === 0) return
    setBusy(true)
    try {
      await exportGcode()
    } finally {
      setBusy(false)
    }
  }

  const onPlot = async () => {
    if (elements.length === 0 || !device) return
    setPlotting(true)
    try {
      await plotGcode()
      toast.success(`Sent to ${device.printerName}`)
    } catch (e) {
      const code = e instanceof BridgeError ? e.code : 'INTERNAL'
      if (code !== 'CANCELLED') toast.error(plotErrorMessage(code))
    } finally {
      setPlotting(false)
    }
  }

  return (
    <header
      role="toolbar"
      aria-label="Main toolbar"
      className="col-span-full flex min-w-0 items-center gap-2 border-b border-border bg-surface px-3 py-2"
    >
      {/* Inspector drawer toggle — mobile only, pinned far left (the panel/hamburger). Desktop has
          the static inspector, so it's hidden there. */}
      <IconButton
        className="md:hidden"
        onClick={toggleInspector}
        aria-label="Toggle inspector"
        title="Toggle inspector"
      >
        <PanelRight size={17} />
      </IconButton>

      {/* Logo — hidden on the narrowest phones to give the doc name room. */}
      <div className="hidden items-center gap-2 sm:flex">
        <LogoMark className="text-accent" />
        <span className="hidden text-[15px] font-semibold tracking-tight lg:inline">
          Kurvengefahr
        </span>
      </div>

      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />
      <DocumentMenu />
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />

      {/* Undo / redo */}
      <IconButton
        onClick={() => undo()}
        disabled={!canUndo}
        aria-label="Undo"
        title={`Undo (${MOD_KEY}Z)`}
      >
        <Undo2 size={17} />
      </IconButton>
      <IconButton
        onClick={() => redo()}
        disabled={!canRedo}
        aria-label="Redo"
        title={`Redo (${MOD_KEY}⇧Z)`}
      >
        <Redo2 size={17} />
      </IconButton>
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden />

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
      <Button
        onClick={togglePreview}
        disabled={preparing}
        aria-label={previewActive ? 'Exit preview' : 'Preview toolpath'}
        title={previewActive ? 'Back to editing' : 'Preview the toolpath'}
      >
        {previewActive ? <Pencil size={15} /> : <Play size={15} />}
        <span className="hidden sm:inline">
          {previewActive ? 'Edit' : preparing ? 'Preparing…' : 'Preview'}
        </span>
      </Button>
      {device && (
        <Button
          variant="primary"
          onClick={onPlot}
          disabled={plotting || elements.length === 0 || profileInvalid}
          aria-label={`Plot to ${device.printerName}`}
          title={profileInvalid ? 'Fix the machine profile to plot' : `Plot to ${device.printerName}`}
        >
          <Printer size={15} />
          <span className="hidden sm:inline">{plotting ? 'Sending…' : 'Plot'}</span>
        </Button>
      )}
      <Button
        variant={device ? 'default' : 'primary'}
        onClick={onGenerate}
        disabled={busy || profileInvalid}
        aria-label="Generate and download G-code"
        title={profileInvalid ? 'Fix the machine profile to generate G-code' : `Generate & download G-code (${MOD_KEY}S)`}
      >
        <Download size={15} />
        <span className="hidden sm:inline">{busy ? 'Generating…' : 'Generate G-code'}</span>
      </Button>

      {/* Help / About + keyboard shortcuts. */}
      <IconButton
        onClick={toggleHelp}
        aria-label="Help and about"
        aria-haspopup="dialog"
        title="Shortcuts & about (?)"
      >
        <CircleHelp size={17} />
      </IconButton>
    </header>
  )
}
