// Share dialog: runs the share pipeline the moment it opens (export → encrypt → proof-of-work →
// upload, see share/shareFlow.ts) and ends in a copyable link. Errors render as an in-dialog
// Banner with a retry — a retry after a network flake resumes the attempt, so the paid-for
// proof-of-work isn't re-mined. Only mounted when sharing is available (share/config.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Banner, Button, Modal, controlClass, cx } from './primitives'
import { useShareDialog } from '../store/shareDialog'
import { toast } from '../store/toast'
import { runShare, type SharePhase, type ShareResult } from '../share/shareFlow'

type State =
  | { kind: 'running'; phase: SharePhase }
  | { kind: 'done'; result: ShareResult }
  | { kind: 'error'; message: string }

const STEPS: { key: SharePhase['step']; label: string }[] = [
  { key: 'exporting', label: 'Export the document' },
  { key: 'encrypting', label: 'Encrypt in your browser' },
  { key: 'preflight', label: 'Check the share service' },
  { key: 'pow', label: 'Proof of work' },
  { key: 'uploading', label: 'Upload' },
]

function Steps({ phase }: { phase: SharePhase }) {
  const current = STEPS.findIndex((s) => s.key === phase.step)
  return (
    <ul className="mt-3 flex flex-col gap-1.5">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={cx(
            'flex items-center gap-2 text-xs',
            i < current ? 'text-muted' : i === current ? 'text-text' : 'text-faint',
          )}
        >
          <span className="flex h-4 w-4 items-center justify-center">
            {i < current ? (
              <Check size={13} aria-hidden />
            ) : i === current ? (
              <Loader2 size={13} className="animate-spin" aria-hidden />
            ) : (
              <span aria-hidden className="h-1 w-1 rounded-full bg-current" />
            )}
          </span>
          {s.label}
          {s.key === 'pow' && phase.step === 'pow' && (
            <span className="text-faint">~{Math.round(phase.probability * 100)}%</span>
          )}
        </li>
      ))}
      {phase.step === 'pow' && (
        <li className="pl-6 text-2xs text-faint">
          A small computation that keeps bots from filling the server — a few seconds for large
          documents.
        </li>
      )}
    </ul>
  )
}

function retentionLine(days: number | null): string {
  return days === null
    ? 'The link stays available indefinitely.'
    : `The link stays available for about ${days} days.`
}

function ShareDialogBody() {
  const [state, setState] = useState<State>({ kind: 'running', phase: { step: 'exporting' } })
  const abortRef = useRef<AbortController | null>(null)

  const start = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setState({ kind: 'running', phase: { step: 'exporting' } })
    runShare((phase) => setState({ kind: 'running', phase }), ctrl.signal).then(
      (result) => setState({ kind: 'done', result }),
      (err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      },
    )
  }, [])

  useEffect(() => {
    start()
    return () => abortRef.current?.abort()
  }, [start])

  // Referentially stable — Modal's focus effect re-runs on change (see primitives.tsx).
  const close = useCallback(() => useShareDialog.getState().set(false), [])

  const copy = (url: string) => {
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success('Link copied'))
      .catch(() => toast.error('Could not access the clipboard — copy the link manually'))
  }

  return (
    <Modal title="Share" onClose={close} className="w-[26rem]">
      <p className="text-xs text-muted">
        Shares a <span className="text-text">snapshot</span> of this document — later edits won't
        change what the link shows. It's encrypted in your browser; the key lives in the link's{' '}
        <code>#…</code> part and is never sent to the server.
      </p>

      {state.kind === 'running' && <Steps phase={state.phase} />}

      {state.kind === 'error' && (
        <div className="mt-3">
          <Banner variant="warn">{state.message}</Banner>
        </div>
      )}

      {state.kind === 'done' && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              className={cx(controlClass, 'min-w-0 flex-1 font-mono text-xs')}
              readOnly
              value={state.result.url}
              aria-label="Share link"
              onFocus={(e) => e.target.select()}
            />
            <Button variant="primary" onClick={() => copy(state.result.url)}>
              Copy
            </Button>
          </div>
          <p className="text-2xs text-faint">
            Opening the link shows a read-only view with a "Save a copy" option.{' '}
            {retentionLine(state.result.retentionDays)}
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        {state.kind === 'error' ? (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" onClick={start}>
              Try again
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={close}>
            {state.kind === 'done' ? 'Close' : 'Cancel'}
          </Button>
        )}
      </div>
    </Modal>
  )
}

export function ShareDialog() {
  const open = useShareDialog((s) => s.open)
  // Mount fresh per open so the share attempt starts (and aborts) with the dialog.
  return open ? <ShareDialogBody /> : null
}
