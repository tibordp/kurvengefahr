// Shared numeric controls (Num, SliderNum) + pen palette UI (PenSwatch, PenSelect).
import { useEffect, useState } from 'react'
import { useDoc } from '../../store/document'
import { Field, controlClass, cx } from '../primitives'

// Display value rounded to a sensible number of decimals (full precision is still stored and
// editable — this only affects what's shown when not actively typing). mm/degrees/scale read fine at
// 2 places; a finer-stepped field (e.g. 0.005) shows enough to resolve its step. Trailing zeros are
// trimmed (140, not 140.00).
const display = (v: number, decimals = 2) =>
  Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : '0'

const decimalsOf = (step: number) => {
  const i = String(step).indexOf('.')
  return i < 0 ? 0 : String(step).length - i - 1
}
/** Decimals to display for a field: 2 by default, more only if the step is finer. */
const displayDecimals = (step: number) => Math.max(2, decimalsOf(step))

// A numeric field that uses `type="text"` so intermediate states ("-", "1.", "") survive while
// typing (type="number" reports an empty value mid-typing, which clobbers negatives). It keeps
// a local string while focused and only commits valid numbers; ArrowUp/Down step like a number
// input. On blur it re-syncs to the canonical value.
export function Num({
  label,
  value,
  step = 1,
  onChange,
  title,
}: {
  label: string
  value: number
  step?: number
  onChange: (v: number) => void
  title?: string
}) {
  const dec = displayDecimals(step)
  const [text, setText] = useState(() => display(value, dec))
  const [focused, setFocused] = useState(false)

  // Mirror external changes (canvas drag, selection switch) only when not actively editing.
  useEffect(() => {
    if (!focused) setText(display(value, dec))
  }, [value, focused, dec])

  const stepBy = (dir: number) => {
    const base = Number.isFinite(parseFloat(text)) ? parseFloat(text) : value
    const next = Number(((Number.isFinite(base) ? base : 0) + dir * step).toFixed(6))
    setText(String(next))
    onChange(next)
  }

  return (
    <Field label={label} title={title}>
      <input
        type="text"
        inputMode="decimal"
        className={controlClass}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepBy(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepBy(-1)
          }
        }}
      />
    </Field>
  )
}

/** Compact, right-aligned number input that pairs with a slider (narrow — the inspector column is
 *  tight). Mirrors {@link Num}'s local-edit-then-commit behaviour. */
export const numFieldClass =
  'w-[3.6em] shrink-0 rounded-md border border-border bg-surface px-1 h-8 text-sm text-right ' +
  'tabular-nums text-text outline-none transition-colors hover:border-border-strong ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35'

/** A slider with an inline editable number box. The slider's `max` is a *soft* bound — typing a
 *  larger value is allowed (and the thumb just pins at max) unless `hardMax`. `int` rounds. This is
 *  the default raster knob: drag for feel, type for precision, exceed the range when you want to. */
export function SliderNum({
  label, title, min, max, step, value, onChange, hardMax = false, int = false, disabled = false,
}: {
  label: string
  title?: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  hardMax?: boolean
  int?: boolean
  disabled?: boolean
}) {
  const dec = int ? 0 : displayDecimals(step)
  const [text, setText] = useState(() => display(value, dec))
  const [focused, setFocused] = useState(false)
  // Mirror external changes (slider drag, regenerate, selection switch) only when not typing.
  useEffect(() => {
    if (!focused) setText(display(value, dec))
  }, [value, focused, dec])

  const clampNum = (n: number) => {
    let v = int ? Math.round(n) : n
    v = Math.max(min, v)
    return hardMax ? Math.min(max, v) : v
  }
  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (Number.isFinite(n)) onChange(clampNum(n))
  }
  const sliderVal = Math.min(max, Math.max(min, value))

  return (
    <Field label={label} title={title}>
      <div className={cx('flex min-w-0 items-center gap-1.5', disabled && 'opacity-40')}>
        <input
          type="range"
          className="min-w-0 flex-1"
          min={min}
          max={max}
          step={step}
          value={sliderVal}
          disabled={disabled}
          onChange={(e) => onChange(clampNum(parseFloat(e.target.value)))}
        />
        <input
          type="text"
          inputMode="decimal"
          className={numFieldClass}
          value={text}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false)
            commit(e.target.value)
          }}
          onChange={(e) => {
            setText(e.target.value)
            commit(e.target.value)
          }}
        />
      </div>
    </Field>
  )
}

/** Default colours offered when adding a pen — a readable, distinct cycle. */
export const PEN_PALETTE = ['#1a1a1a', '#E5484D', '#2563EB', '#16A34A', '#D97706', '#7C3AED', '#0891B2', '#DB2777']

export function PenSwatch({ color }: { color: string }) {
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 rounded-sm border border-black/15"
      style={{ background: color }}
      aria-hidden
    />
  )
}

/** Assign an element (or selection) to a pen. `value === null` = a mixed selection. */
export function PenSelect({ value, onChange }: { value: number | null; onChange: (pen: number) => void }) {
  const pens = useDoc((s) => s.profile.pens)
  const current = value === null ? undefined : pens.find((p) => p.id === value)
  return (
    <Field label="Pen">
      <div className="flex min-w-0 items-center gap-2">
        <PenSwatch color={current?.color ?? '#1a1a1a'} />
        <select
          className={controlClass}
          value={value ?? ''}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {value === null && <option value="">Mixed</option>}
          {pens.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </Field>
  )
}
