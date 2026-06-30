// Transient toast stack, top-centered over the canvas. Mounted once in App. Feedback for app-bar
// actions (Plot). Calm neutral surface cards (like the app's modals/menus) with a colored icon —
// signal-red for errors, an emerald check for success, muted for info.
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
    <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex w-[calc(100vw_-_1rem)] -translate-x-1/2 flex-col items-stretch gap-2 md:max-w-[28rem]">
      {[...toasts].reverse().map((t) => {
        const Icon = ICON[t.kind]
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text shadow-lg motion-safe:animate-toast-in"
          >
            <Icon size={18} className={cx('shrink-0', ICON_COLOR[t.kind])} />
            <span className="min-w-0 flex-1">{t.message}</span>
            <button
              className="-mr-1 shrink-0 rounded p-1 text-faint transition-colors hover:bg-bg hover:text-text"
              title="Dismiss"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              <X size={15} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
