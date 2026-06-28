// Transient toast stack, bottom-right. Mounted once in App. Feedback for app-bar actions (Plot).
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { useToast, type ToastKind } from '../store/toast'
import { cx } from './primitives'

const ICON = { success: CheckCircle2, error: AlertTriangle, info: Info }
const ICON_COLOR: Record<ToastKind, string> = {
  success: 'text-emerald-500',
  error: 'text-accent-text',
  info: 'text-muted',
}

export function Toaster() {
  const toasts = useToast((s) => s.toasts)
  const dismiss = useToast((s) => s.dismiss)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[min(22rem,90vw)] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = ICON[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text shadow-lg"
          >
            <Icon size={16} className={cx('mt-0.5 shrink-0', ICON_COLOR[t.kind])} />
            <span className="min-w-0 flex-1">{t.message}</span>
            <button
              className="shrink-0 rounded p-0.5 text-faint hover:bg-bg hover:text-text"
              title="Dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
