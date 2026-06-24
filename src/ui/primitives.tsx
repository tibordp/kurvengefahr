// Small, shared UI primitives. Centralising the button/field/banner styling here (rather than
// repeating utility soup or scattering @apply) is what keeps the chrome cohesive as element types
// grow. Everything is plain Tailwind utilities over the tokens in index.css.
import type { ButtonHTMLAttributes, ReactNode } from 'react'

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

type Variant = 'default' | 'primary' | 'warn' | 'ghost'

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
