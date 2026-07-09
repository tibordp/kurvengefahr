// The profile picker: a searchable combobox-style popover over the preset catalog. The native
// <select> stopped scaling once presets covered whole machine families — this groups saved
// profiles first (they're *your* machines), then presets by kind, with the work area as a
// right-aligned hint. Filter + arrow keys + Enter; Esc or outside click closes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Search } from 'lucide-react'
import { useDoc } from '../../store/document'
import { useLibrary } from '../../store/library'
import { PRESET_GROUP_LABELS, PROFILE_PRESETS } from '../../store/profiles'
import type { MachineProfile } from '../../core/types'
import { controlClass, cx } from '../primitives'

interface Group {
  label: string
  profiles: MachineProfile[]
}

export function ProfilePicker({ detached }: { detached: boolean }) {
  const profile = useDoc((s) => s.profile)
  const selectProfile = useDoc((s) => s.selectProfile)
  const custom = useLibrary((s) => s.customProfiles)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Saved profiles first — they're the user's actual machines — then presets grouped by kind
  // in catalog order. The filter matches name or group label, case-insensitive.
  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (p: MachineProfile, label: string) =>
      !q || p.name.toLowerCase().includes(q) || label.toLowerCase().includes(q)
    const out: Group[] = []
    const saved = custom.filter((p) => match(p, 'my profiles'))
    if (saved.length) out.push({ label: 'My profiles', profiles: saved })
    for (const kind of ['prusa', 'axidraw', 'grbl'] as const) {
      const label = PRESET_GROUP_LABELS[kind]
      const profiles = PROFILE_PRESETS.filter((p) => p.kind === kind && match(p, label))
      if (profiles.length) out.push({ label, profiles })
    }
    return out
  }, [custom, query])

  const flat = useMemo(() => groups.flatMap((g) => g.profiles), [groups])

  useEffect(() => setActive(0), [query, open])

  useEffect(() => {
    if (!open) return
    searchRef.current?.focus()
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (id: string) => {
    selectProfile(id)
    setOpen(false)
    setQuery('')
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
      e.preventDefault()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = Math.max(0, Math.min(flat.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)))
      setActive(next)
      listRef.current
        ?.querySelector(`[data-idx="${next}"]`)
        ?.scrollIntoView({ block: 'nearest' })
      e.preventDefault()
    } else if (e.key === 'Enter') {
      if (flat[active]) pick(flat[active].id)
      e.preventDefault()
    }
  }

  let idx = -1
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(controlClass, 'flex cursor-pointer items-center justify-between gap-2 text-left')}
      >
        <span className="truncate">
          {profile.name || 'Unsaved profile'}
          {detached && <span className="text-faint"> (unsaved)</span>}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-md border border-border bg-surface shadow-panel"
          onKeyDown={onKey}
        >
          <div className="flex items-center gap-1.5 border-b border-border px-2">
            <Search size={13} className="shrink-0 text-faint" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search machines…"
              className="h-8 w-full bg-transparent text-sm text-text outline-none placeholder:text-faint"
            />
          </div>
          <div ref={listRef} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {flat.length === 0 && <div className="px-2 py-3 text-center text-xs text-faint">No machines match.</div>}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-faint">
                  {g.label}
                </div>
                {g.profiles.map((p) => {
                  idx++
                  const i = idx
                  const current = p.id === profile.id
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="option"
                      aria-selected={current}
                      data-idx={i}
                      onClick={() => pick(p.id)}
                      onMouseMove={() => setActive(i)}
                      className={cx(
                        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors',
                        i === active ? 'bg-bg text-text' : 'text-text',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      <span className="shrink-0 font-mono text-2xs tabular-nums text-faint">
                        {p.bed.width}×{p.bed.height}
                      </span>
                      {current && <Check size={13} className="shrink-0 text-accent-text" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
