// Small, shared UI primitives. Centralising the button/field/banner styling here (rather than
// repeating utility soup or scattering @apply) is what keeps the chrome cohesive as element types
// grow. Everything is plain Tailwind utilities over the tokens in index.css.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'

/** Tiny classname joiner (drops falsy values). */
export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ')

// Shared form-control styling: consistent height, border, and an accent focus ring.
export const controlClass =
  'w-full rounded-md border border-border bg-surface px-2 h-8 text-sm text-text outline-none ' +
  'transition-colors placeholder:text-faint hover:border-border-strong ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35'

export const textareaClass =
  'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text outline-none ' +
  'transition-colors placeholder:text-faint hover:border-border-strong resize-y ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35'

type Variant = 'default' | 'primary' | 'warn' | 'ghost' | 'danger'

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium ' +
  'transition-colors cursor-pointer select-none outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent/45 ' +
  'active:translate-y-px disabled:opacity-50 disabled:pointer-events-none'

const variants: Record<Variant, string> = {
  default: 'h-8 px-3 border border-border bg-surface text-text hover:bg-bg',
  primary: 'h-8 px-3 bg-accent-solid text-white hover:bg-accent-solid-hover',
  warn: 'h-8 px-3 border border-warn-border bg-warn-bg text-warn-text hover:brightness-[0.98]',
  ghost: 'h-8 px-3 text-muted hover:bg-bg hover:text-text',
  // Destructive — outlined accent-red (not a solid fill, so it reads as "careful" not "primary").
  danger: 'h-8 px-3 border border-accent-border bg-surface text-accent-text hover:bg-accent-subtle',
}

export function Button({
  variant = 'default',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={cx(base, variants[variant], className)} {...props} />
}

/** Square ghost button for icons. `aria-label` is required for a11y (icon-only). */
export function IconButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label': string }) {
  return (
    <button
      className={cx(
        base,
        'h-8 w-8 text-muted hover:bg-bg hover:text-text shrink-0',
        className,
      )}
      {...props}
    />
  )
}

/** A label + control row. `full` stacks them; otherwise a 2-column grid (label | control). */
export function Field({
  label,
  title,
  full,
  children,
}: {
  label?: ReactNode
  title?: string
  full?: boolean
  children: ReactNode
}) {
  if (full) {
    return (
      <div className="mb-2">
        {label && (
          <label title={title} className="mb-1 block text-xs text-muted">
            {label}
          </label>
        )}
        {children}
      </div>
    )
  }
  return (
    <div className="mb-1.5 grid grid-cols-2 items-center gap-2">
      <label title={title} className="text-xs text-muted">
        {label}
      </label>
      {children}
    </div>
  )
}

export function SectionTitle({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <h3
      title={title}
      className="mb-2 mt-5 text-2xs font-semibold uppercase tracking-wider text-muted first:mt-0"
    >
      {children}
    </h3>
  )
}

/** A click-to-open dropdown menu. Closes on outside-click, Esc, or any click inside the panel.
 *  `trigger` renders the button; `children` are `MenuItem`s / `MenuSeparator`s / `MenuLabel`s. */
export function Menu({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (p: { open: boolean }) => ReactNode
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger({ open })}</div>
      {open && (
        <div
          className={cx(
            'absolute z-40 mt-1 min-w-48 rounded-md border border-border bg-surface p-1 shadow-panel',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** A context menu pinned to viewport coords (x, y) — e.g. a right-click. Clamps to stay on-screen,
 *  and closes on outside-click, Esc, scroll, resize, or any click inside (action then bubbles).
 *  Children are the same `MenuItem`/`MenuSeparator`/`MenuLabel`s as {@link Menu}. */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Clamp within the viewport once we know the panel's size (before paint → no flash).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-panel"
      style={{ left: pos.x, top: pos.y }}
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>
  )
}

export function MenuItem({
  danger,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      className={cx(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
        'disabled:pointer-events-none disabled:opacity-40',
        danger ? 'text-accent-text hover:bg-accent-subtle' : 'text-text hover:bg-bg',
        className,
      )}
      {...props}
    />
  )
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-faint">
      {children}
    </div>
  )
}

/** An accessible modal dialog: a centred panel over a scrim. Closes on Esc or backdrop click;
 *  focus moves into the panel on open, is trapped (Tab cycles within), and is restored to the
 *  previously-focused element on close. `title` labels the dialog for screen readers. */
export function Modal({
  title,
  onClose,
  children,
  className,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = `dlg-${title.replace(/\W+/g, '-').toLowerCase()}`

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null
    // Focus the panel itself; it's tabindex=-1 so it accepts focus without being a tab stop.
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !panel.current) return
      // Minimal focus trap: keep Tab within the panel's focusable descendants.
      const f = panel.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!f.length) return
      const first = f[0]
      const last = f[f.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restore?.focus?.()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cx(
          'flex max-h-[85vh] w-[min(34rem,92vw)] flex-col overflow-hidden rounded-card border ' +
            'border-border bg-surface shadow-panel outline-none',
          className,
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-text">
            {title}
          </h2>
          <IconButton aria-label="Close dialog" title="Close (Esc)" onClick={onClose}>
            <span aria-hidden className="text-base leading-none">
              ✕
            </span>
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  )
}

/** Inline status/alert. `info` (accent-tinted) or `warn` (amber). Optional trailing action. */
export function Banner({
  variant = 'info',
  children,
  action,
}: {
  variant?: 'info' | 'warn'
  children: ReactNode
  action?: ReactNode
}) {
  const tone =
    variant === 'warn'
      ? 'border-warn-border bg-warn-bg text-warn-text'
      : 'border-accent-border bg-accent-subtle text-accent-text'
  return (
    <div
      className={cx(
        'mb-2 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs',
        tone,
      )}
    >
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  )
}
