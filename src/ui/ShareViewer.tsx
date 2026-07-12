// The share-link app shell: a read-only view of a shared snapshot (see share/viewer.ts for the
// boot machine). Minimal chrome — branding, doc name, an "Edit a copy" action — over the
// ViewerCanvas. Rendered by main.tsx *instead of* App when the URL carries a share fragment;
// worker-backed elements regenerate through the same generation manager the editor uses.
import { useState } from 'react'
import { CircleHelp, Loader2 } from 'lucide-react'
import { useGenerationManager } from '../App'
import { ViewerCanvas } from '../canvas/ViewerCanvas'
import { useGeneration } from '../core/generation'
import { saveViewerCopy, useViewer, type ViewerErrorKind } from '../share/viewer'
import { toast } from '../store/toast'
import { useUI } from '../store/ui'
import { HelpDialog } from './HelpDialog'
import { Banner, Button, IconButton } from './primitives'
import { Toaster } from './Toaster'
import { LogoMark } from './Toolbar'

const LOADING_LABEL = {
  fetching: 'Fetching the shared document…',
  decrypting: 'Decrypting in your browser…',
  preparing: 'Preparing…',
} as const

const ERROR_COPY: Record<ViewerErrorKind, { title: string; body: string }> = {
  unavailable: {
    title: 'Sharing is disabled in this build',
    body: 'This Kurvengefahr instance was built without a share service, so it cannot open share links.',
  },
  insecure: {
    title: 'Sharing needs a secure connection',
    body: 'Shared documents are decrypted in the browser, which requires HTTPS. Open this link on a secure origin.',
  },
  'bad-link': {
    title: 'This share link is incomplete',
    body: "Make sure the whole link was copied — everything after the # matters, including the part after the dot.",
  },
  'not-found': {
    title: 'This share does not exist or has expired',
    body: 'Shared documents are kept for a limited time. Ask the sender to share it again.',
  },
  'wrong-key': {
    title: "The link's key does not match",
    body: 'The document was found but could not be decrypted — the part of the link after the dot is probably truncated or altered.',
  },
  corrupt: {
    title: 'This share could not be read',
    body: 'The stored data is not a valid Kurvengefahr document.',
  },
  network: {
    title: 'Could not reach the share service',
    body: 'Check your connection and try again.',
  },
}

function CenteredScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-center text-text">
      {children}
    </div>
  )
}

function EditCopyButton() {
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="primary"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        saveViewerCopy().catch(() => {
          setBusy(false)
          toast.error('Could not save a copy — storage may be full or blocked.')
        })
      }}
    >
      {busy ? 'Opening…' : 'Edit a copy'}
    </Button>
  )
}

/** Spinner while any element is still (re)generating; shared docs carry params, not geometry. */
function RenderingIndicator() {
  const statuses = useGeneration((s) => s.status)
  const busy = Object.values(statuses).some((st) => st.phase !== 'error')
  if (!busy) return null
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <Loader2 size={13} className="animate-spin" aria-hidden /> Rendering…
    </span>
  )
}

function GenerationErrorBanner() {
  const statuses = useGeneration((s) => s.status)
  const failed = Object.values(statuses).some((st) => st.phase === 'error')
  if (!failed) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4">
      <div className="pointer-events-auto">
        <Banner variant="warn">Some elements could not be rendered.</Banner>
      </div>
    </div>
  )
}

export function ShareViewer() {
  useGenerationManager()
  const state = useViewer((s) => s.state)

  if (state.phase === 'loading') {
    return (
      <CenteredScreen>
        <LogoMark className="text-accent" />
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={15} className="animate-spin" aria-hidden />
          {LOADING_LABEL[state.step]}
        </p>
      </CenteredScreen>
    )
  }

  if (state.phase === 'error') {
    const copy = ERROR_COPY[state.kind]
    return (
      <CenteredScreen>
        <LogoMark className="text-accent" />
        <h1 className="text-lg font-semibold">{copy.title}</h1>
        <p className="max-w-md text-sm text-muted">{copy.body}</p>
        <div className="mt-1 flex items-center gap-2">
          {state.kind === 'network' && (
            <Button variant="primary" onClick={() => location.reload()}>
              Retry
            </Button>
          )}
          <Button variant={state.kind === 'network' ? 'ghost' : 'primary'} onClick={() => (location.href = location.pathname)}>
            Open Kurvengefahr
          </Button>
        </div>
      </CenteredScreen>
    )
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] overflow-hidden bg-bg text-text">
      <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <a href={location.pathname} className="flex shrink-0 items-center gap-2" title="Open Kurvengefahr">
          <LogoMark className="text-accent" />
          <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">Kurvengefahr</span>
        </a>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <span className="min-w-0 truncate text-sm font-medium">{state.name.trim() || 'Untitled'}</span>
        {/* Hidden on mobile — the document title gets the width (read-only is apparent anyway). */}
        <span className="hidden shrink-0 rounded-full border border-border bg-bg px-2 py-0.5 text-2xs text-muted md:inline">
          Read-only snapshot
        </span>
        <div className="flex-1" />
        <RenderingIndicator />
        <EditCopyButton />
        <IconButton
          onClick={() => useUI.getState().toggleHelp()}
          aria-label="Help and about"
          aria-haspopup="dialog"
          title="About Kurvengefahr"
        >
          <CircleHelp size={17} />
        </IconButton>
      </header>
      <main className="relative flex min-h-0 min-w-0 flex-col">
        <GenerationErrorBanner />
        <ViewerCanvas />
      </main>
      <HelpDialog shortcuts={false} />
      <Toaster />
    </div>
  )
}
