// Per-element generation feedback banner (model load, progress, error+retry).
import { useGeneration, regenerate } from '../../core/generation'
import { Banner } from '../primitives'

/** Per-element generation feedback: model load on first use, per-line progress, or an error with
 *  retry. Generation runs in a worker; the element keeps showing its previous ink meanwhile. */
export function GenerationNote({ id, reserveIdle = true }: { id: string; reserveIdle?: boolean }) {
  const status = useGeneration((s) => s.status[id])
  // A failure is a persistent, actionable state → a normal banner (it doesn't flash in and out).
  if (status?.phase === 'error') {
    return (
      <Banner
        variant="warn"
        action={
          <button
            className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
            onClick={() => regenerate(id)}
          >
            Retry
          </button>
        }
      >
        ⚠ Generation failed{status.message ? `: ${status.message}` : ''}
      </Banner>
    )
  }
  // Loading / generating flash in and out — a live re-trace fires on every edit. Keep this a
  // fixed-height, single-line slot so showing or clearing the label never reflows the inspector.
  // Handwriting streams word by word (show the line count); raster lands in one shot (no count).
  const progress = status?.total && status.total > 1 ? ` ${status.done ?? 0}/${status.total} lines` : ''
  const text =
    status?.phase === 'loading-model'
      ? '⏳ Loading handwriting model… (first use only)'
      : status?.phase === 'generating'
        ? `✎ Generating…${progress}`
        : ''
  // When there's nothing to say, callers that re-trace constantly (raster) reserve the slot to
  // avoid reflow; ones that generate only on a deliberate Regenerate (handwriting) collapse it so
  // there's no dead gap under the header.
  if (!text && !reserveIdle) return null
  return (
    <p className="mb-2 h-4 truncate text-xs text-muted" aria-live="polite">
      {text && <span className="animate-pulse">{text}</span>}
    </p>
  )
}
