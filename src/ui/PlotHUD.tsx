// Live plotting UI (AxiDraw or GRBL), in two pieces: the toolbar's Plot button (idle), and the
// plot HUD — a bottom-of-canvas transport bar (same slot and styling as the preview transport)
// with progress + ETA + current pen + pause/stop, plus the operator-prompt modal (fiducial
// alignment / pen swaps have no LCD to pause on; the app is the operator interface).
import { Pause, Play, Printer, Square } from 'lucide-react'
import { confirmDialog } from '../store/dialogs'
import { useDoc } from '../store/document'
import { usePlotSession } from '../store/plotSession'
import { useSerial } from '../store/serial'
import { validateProfile } from '../core/profileValidation'
import { Button, IconButton, Modal } from './primitives'

function fmtEta(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const PHASE_LABEL: Record<string, string> = {
  planning: 'Planning…',
  pausing: 'Pausing…',
  paused: 'Paused',
  waiting: 'Waiting…',
}

/** The toolbar's output button for serial-plotted profiles (AxiDraw / GRBL). While a session runs
 *  the transport bar ({@link PlotHUD}) owns the controls, so this renders nothing. */
export function SerialPlotCluster() {
  const phase = usePlotSession((s) => s.phase)
  const connected = useSerial((s) => s.connected)
  const elements = useDoc((s) => s.elements)
  const profileInvalid = useDoc((s) => validateProfile(s.profile).length > 0)
  const kind = useDoc((s) => s.profile.kind)
  const homing = useDoc((s) => (s.profile.kind === 'grbl' ? s.profile.homing : false))
  const start = usePlotSession((s) => s.start)

  if (phase !== 'idle') return null

  const machine = kind === 'axidraw' ? 'AxiDraw' : 'plotter'
  const parkHint =
    kind === 'axidraw'
      ? 'park the carriage at the home corner first'
      : homing
        ? 'the machine homes first'
        : 'the job starts from the current pen position'
  const disabled = !connected || elements.length === 0 || profileInvalid
  return (
    <Button
      variant="primary"
      onClick={() => void start()}
      disabled={disabled}
      aria-label={`Plot on the ${machine}`}
      title={
        !connected
          ? `Connect the ${machine} in Machine settings to plot`
          : profileInvalid
            ? 'Fix the machine profile to plot'
            : `Plot on the ${machine} (${parkHint})`
      }
    >
      <Printer size={15} />
      <span className="hidden sm:inline">Plot</span>
    </Button>
  )
}

/** The live plot transport bar under the canvas (mounted beside PreviewControls in App; only one
 *  of the two is ever visible — a running session puts the preview in `driven` mode). */
export function PlotHUD() {
  const phase = usePlotSession((s) => s.phase)
  const done = usePlotSession((s) => s.done)
  const total = usePlotSession((s) => s.total)
  const etaMs = usePlotSession((s) => s.etaMs)
  const currentPen = usePlotSession((s) => s.currentPen)
  const prompt = usePlotSession((s) => s.prompt)
  const pens = useDoc((s) => s.profile.pens)
  const s = usePlotSession.getState()

  if (phase === 'idle') return null

  const pen = pens.find((p) => p.id === currentPen)
  const frac = total > 0 ? Math.min(1, done / total) : 0

  return (
    <div
      role="group"
      aria-label="Plot progress"
      className="m-2 flex shrink-0 items-center gap-2.5 rounded-card border border-border bg-surface px-2.5 py-2 shadow-panel"
    >
      <span
        className="h-3.5 w-3.5 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: pen?.color }}
        title={pen ? `Current pen: ${pen.name}` : undefined}
      />
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border" aria-hidden>
        <div className="h-full bg-accent-solid transition-[width]" style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="min-w-[72px] text-right font-mono text-xs tabular-nums text-muted">
        {phase === 'plotting' ? (etaMs !== null ? `−${fmtEta(etaMs)}` : '…') : PHASE_LABEL[phase]}
      </span>
      {phase === 'paused' ? (
        <IconButton aria-label="Resume plot" title="Resume plot" onClick={s.resume}>
          <Play size={14} />
        </IconButton>
      ) : (
        <IconButton
          aria-label="Pause plot"
          title="Pause at the next safe point"
          disabled={phase !== 'plotting'}
          onClick={s.pause}
        >
          <Pause size={14} />
        </IconButton>
      )}
      <IconButton
        aria-label="Stop plot"
        title="Stop the plot — the pen lifts and returns home"
        onClick={async () => {
          const ok = await confirmDialog({
            title: 'Stop plot',
            message: 'Stop the plot? The pen will lift and return home.',
            confirmLabel: 'Stop plot',
            danger: true,
          })
          if (ok) s.cancel()
        }}
      >
        <Square size={14} />
      </IconButton>
      {prompt && <OperatorPrompt kind={prompt.kind} penName={pens.find((p) => p.id === prompt.pen)?.name} />}
    </div>
  )
}

function OperatorPrompt({ kind, penName }: { kind: 'fiducial' | 'penSwap'; penName?: string }) {
  const confirmPrompt = usePlotSession((s) => s.confirmPrompt)
  const title = kind === 'fiducial' ? 'Align to the fiducial' : `Change to ${penName ?? 'the next pen'}`
  return (
    // Closing (Esc/backdrop) keeps the machine safely paused with the prompt up — deliberate:
    // dismissing must never mean "continue" or "abort" for a physical machine.
    <Modal title={title} onClose={() => {}}>
      <p className="text-sm text-muted">
        {kind === 'fiducial'
          ? 'The pen is parked over the alignment point. Align the medium under it, then continue.'
          : `The pen is up and the carriage is holding still. Swap in ${penName ?? 'the next pen'}, then continue.`}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => confirmPrompt(false)}>Stop plot</Button>
        <Button variant="primary" onClick={() => confirmPrompt(true)} autoFocus>
          Continue
        </Button>
      </div>
    </Modal>
  )
}
