// The Elements tree: every element in the document, organized into flat (non-nesting) groups. The
// reliable way to (re)select things — including an element dragged off the bed or hidden inside a
// collapsed group. Selection here drives the same store as clicking the canvas, both ways. Built for
// many elements (SVG import drops its shapes into one collapsed group): collapse, search, multi-
// select with shift-range and cmd-toggle, group / ungroup, and inline rename.
//
// Perf: the document/groups/query → row-list computation is memoized, the per-element rows are a
// memoized component, and handlers are stable — so a generation tick (which re-renders the whole
// tree via the shared `genStatus`) or a selection change re-renders only the rows that actually
// changed, not every row.
import { memo, useCallback, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronDown,
  Folder,
  Trash2,
  Group as GroupIcon,
  Ungroup,
  Search,
  Signature,
  Type,
  Square,
  Circle,
  Spline,
  Sparkles,
  Image as ImageIcon,
  Scissors,
  Crop,
  type LucideIcon,
} from 'lucide-react'
import { useDoc } from '../store/document'
import { useGeneration, needsManualRegen } from '../core/generation'
import { useHover } from '../store/hover'
import type { DocElement } from '../core/types'
import type { HandwritingParams } from '../elements/handwriting'
import type { PathParams } from '../elements/shapes'
import type { TextParams } from '../elements/text'
import { GEN_KINDS, type GenerativeParams } from '../elements/generative'
import { SectionTitle, controlClass, cx } from './primitives'

/** A label derived from the element's content, used when it has no user-given name. */
function derivedName(el: DocElement): string {
  if (el.type === 'handwriting') {
    const text = (el.params as HandwritingParams).text.replace(/\s+/g, ' ').trim()
    if (!text) return 'Handwriting (empty)'
    return text.length > 20 ? `“${text.slice(0, 20)}…”` : `“${text}”`
  }
  if (el.type === 'text') {
    const t = (el.params as TextParams).text.replace(/\s+/g, ' ').trim()
    return t ? (t.length > 20 ? `${t.slice(0, 20)}…` : t) : 'Text'
  }
  if (el.type === 'generative') {
    const g = el.params as GenerativeParams
    return GEN_KINDS.find((k) => k.key === g.kind)?.name ?? 'Generative'
  }
  if (el.type === 'rect') return 'Rectangle'
  if (el.type === 'ellipse') return 'Ellipse'
  if (el.type === 'path') {
    const p = el.params as PathParams
    const nodeCount = p.contours.reduce((a, c) => a + c.nodes.length, 0)
    const closed = p.contours.length > 0 && p.contours.every((c) => c.closed)
    return `${closed ? 'Shape' : 'Path'} (${nodeCount})`
  }
  if (el.type === 'raster') return 'Image'
  if (el.type === 'clip') return 'Clip'
  return el.type
}

const labelOf = (el: DocElement) => el.name ?? derivedName(el)

const TYPE_ICON: Record<string, LucideIcon> = {
  handwriting: Signature,
  text: Type,
  generative: Sparkles,
  rect: Square,
  ellipse: Circle,
  path: Spline,
  raster: ImageIcon,
  clip: Scissors,
}

/** The generation badge (loading / generating / error / edited) for an element row. */
function statusBadge(phase: string | undefined, dirty: boolean): { text: string; warn: boolean; busy: boolean } {
  if (phase === 'loading-model') return { text: '⏳', warn: false, busy: true }
  if (phase === 'generating') return { text: '✎', warn: false, busy: true }
  if (phase === 'error') return { text: '⚠', warn: true, busy: false }
  if (dirty) return { text: '●', warn: true, busy: false }
  return { text: '', warn: false, busy: false }
}

interface RowHandlers {
  onClick: (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void
  onHover: (id: string | null) => void
  onDelete: (id: string) => void
  onStartRename: (id: string) => void
  onCommitName: (id: string, val: string) => void
  onCancelRename: () => void
}

interface RowProps extends RowHandlers {
  el: DocElement
  nested: boolean
  label: string
  selected: boolean
  color: string
  penTitle: string
  badgeText: string
  badgeWarn: boolean
  badgeBusy: boolean
  badgeTitle: string
  editing: boolean
}

/** One element row. Memoized on its (primitive) props, so a re-render of the whole tree — e.g. a
 *  per-word generation tick — only re-renders rows whose data actually changed. */
const ElementRow = memo(function ElementRow(p: RowProps) {
  const { el } = p
  const Icon = TYPE_ICON[el.type] ?? Spline
  return (
    <li
      className={cx(
        'group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors',
        p.nested && 'ml-4',
        p.selected ? 'border-accent-border bg-accent-subtle' : 'border-transparent hover:bg-bg',
      )}
      onMouseEnter={() => p.onHover(el.id)}
      onMouseLeave={() => p.onHover(null)}
      onClick={(e) => p.onClick(el.id, e)}
    >
      <Icon size={14} className="shrink-0 text-faint" />
      <span
        className="h-3 w-3 shrink-0 rounded-full border border-border"
        style={{ backgroundColor: p.color }}
        title={p.penTitle}
      />
      {p.editing ? (
        <input
          autoFocus
          defaultValue={p.label}
          className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-text outline-none ring-1 ring-accent/50"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => p.onCommitName(el.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') p.onCancelRename()
          }}
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation()
            p.onStartRename(el.id)
          }}
        >
          {p.label}
        </span>
      )}
      {p.badgeText && (
        <span
          className={cx('text-2xs leading-none', p.badgeBusy && 'animate-pulse', p.badgeWarn ? 'text-accent-text' : 'text-muted')}
          title={p.badgeTitle}
        >
          {p.badgeText}
        </span>
      )}
      <button
        className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-accent-text sm:opacity-0 sm:group-hover:opacity-100"
        title="Delete"
        aria-label="Delete element"
        onClick={(e) => {
          e.stopPropagation()
          p.onDelete(el.id)
        }}
      >
        <Trash2 size={14} />
      </button>
    </li>
  )
})

type Row =
  | { kind: 'element'; el: DocElement }
  | { kind: 'group'; id: string; name: string; members: DocElement[]; count: number; expanded: boolean }
  | { kind: 'clip'; el: DocElement }

export function ElementsTree() {
  const elements = useDoc((s) => s.elements)
  const groups = useDoc((s) => s.groups)
  const selectedIds = useDoc((s) => s.selectedIds)
  const pens = useDoc((s) => s.profile.pens)
  const select = useDoc((s) => s.select)
  const selectMany = useDoc((s) => s.selectMany)
  const removeElement = useDoc((s) => s.removeElement)
  const createGroup = useDoc((s) => s.createGroup)
  const ungroup = useDoc((s) => s.ungroup)
  const clipSelected = useDoc((s) => s.clipSelected)
  const renameGroup = useDoc((s) => s.renameGroup)
  const setGroupCollapsed = useDoc((s) => s.setGroupCollapsed)
  const setElementName = useDoc((s) => s.setElementName)
  const unclip = useDoc((s) => s.unclip)
  const genStatus = useGeneration((s) => s.status)
  const setHover = useHover((s) => s.set)

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ kind: 'element' | 'group'; id: string } | null>(null)
  // Clips have no persisted collapsed flag (unlike groups) — track expand state locally.
  const [collapsedClips, setCollapsedClips] = useState<Set<string>>(new Set())
  const toggleClip = useCallback(
    (id: string) =>
      setCollapsedClips((prev) => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      }),
    [],
  )
  const anchor = useRef<string | null>(null)

  // Row list depends only on the document + filter — memoized so a selection change or a generation
  // tick (which re-renders this component) doesn't recompute the whole O(n) grouping.
  const { rows, flatIds, membersByClip } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const groupsById = new Map(groups.map((g) => [g.id, g]))
    const matchesEl = (el: DocElement) => !q || labelOf(el).toLowerCase().includes(q) || el.type.includes(q)

    const clipIds = new Set(elements.filter((e) => e.type === 'clip').map((e) => e.id))
    const membersByClip = new Map<string, DocElement[]>()
    for (const el of elements)
      if (el.clipParent && clipIds.has(el.clipParent)) {
        const arr = membersByClip.get(el.clipParent) ?? []
        arr.push(el)
        membersByClip.set(el.clipParent, arr)
      }

    const membersByGroup = new Map<string, DocElement[]>()
    for (const el of elements) {
      if (el.groupId && groupsById.has(el.groupId)) {
        const arr = membersByGroup.get(el.groupId) ?? []
        arr.push(el)
        membersByGroup.set(el.groupId, arr)
      }
    }

    const out: Row[] = []
    const seenGroup = new Set<string>()
    for (const el of elements) {
      if (el.clipParent && clipIds.has(el.clipParent)) continue // shown nested under its clip
      if (el.groupId && groupsById.has(el.groupId)) {
        const g = groupsById.get(el.groupId)!
        if (seenGroup.has(g.id)) continue
        seenGroup.add(g.id)
        const all = membersByGroup.get(g.id)!
        const members = q ? all.filter(matchesEl) : all
        const groupMatches = !q || g.name.toLowerCase().includes(q)
        if (q && !groupMatches && members.length === 0) continue
        out.push({ kind: 'group', id: g.id, name: g.name, members, count: all.length, expanded: q ? true : !g.collapsed })
      } else if (el.type === 'clip') {
        out.push({ kind: 'clip', el })
      } else if (matchesEl(el)) {
        out.push({ kind: 'element', el })
      }
    }

    // Flat order (for shift-range select), recursing into expanded clips.
    const flat: string[] = []
    const pushClip = (clipEl: DocElement) => {
      flat.push(clipEl.id)
      if (collapsedClips.has(clipEl.id)) return
      for (const m of membersByClip.get(clipEl.id) ?? []) (m.type === 'clip' ? pushClip(m) : flat.push(m.id))
    }
    for (const r of out) {
      if (r.kind === 'element') flat.push(r.el.id)
      else if (r.kind === 'clip') pushClip(r.el)
      else if (r.expanded) for (const m of r.members) flat.push(m.id)
    }
    return { rows: out, flatIds: flat, membersByClip }
  }, [elements, groups, query, collapsedClips])

  // flatIds via a ref so the click handler can stay stable (shift-range reads the latest order).
  const flatIdsRef = useRef<string[]>(flatIds)
  flatIdsRef.current = flatIds

  const onRowClick = useCallback(
    (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      const ids = flatIdsRef.current
      if (e.shiftKey && anchor.current) {
        const a = ids.indexOf(anchor.current)
        const b = ids.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          selectMany(ids.slice(lo, hi + 1))
          return
        }
      }
      if (e.metaKey || e.ctrlKey) select(id, true)
      else select(id, false)
      anchor.current = id
    },
    [select, selectMany],
  )
  const onStartRename = useCallback((id: string) => setEditing({ kind: 'element', id }), [])
  const onCommitName = useCallback((id: string, val: string) => {
    setElementName(id, val.trim())
    setEditing(null)
  }, [setElementName])
  const onCancelRename = useCallback(() => setEditing(null), [])
  const handlers: RowHandlers = { onClick: onRowClick, onHover: setHover, onDelete: removeElement, onStartRename, onCommitName, onCancelRename }

  if (elements.length === 0) return null

  const sel = new Set(selectedIds)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'
  const penName = (pen: number) => pens.find((p) => p.id === pen)?.name ?? pen

  const clickGroup = (members: DocElement[], e: { metaKey: boolean; ctrlKey: boolean }) => {
    const ids = members.map((m) => m.id)
    if (e.metaKey || e.ctrlKey) {
      const allSel = ids.length > 0 && ids.every((i) => sel.has(i))
      selectMany(allSel ? selectedIds.filter((i) => !ids.includes(i)) : [...new Set([...selectedIds, ...ids])])
    } else {
      selectMany(ids)
    }
    anchor.current = ids[0] ?? null
  }

  // Header actions over the current selection.
  const selectedEls = elements.filter((e) => sel.has(e.id))
  const canGroup = selectedEls.length >= 2
  const ungroupIds = [...new Set(selectedEls.map((e) => e.groupId).filter((g): g is string => !!g))]

  const renderElement = (el: DocElement, nested: boolean) => {
    const g = genStatus[el.id]
    const dirty = !g && needsManualRegen(el.id, el.type, el.params)
    const badge = statusBadge(g?.phase, dirty)
    return (
      <ElementRow
        key={el.id}
        el={el}
        nested={nested}
        label={el.clipRole === 'mask' ? `Mask · ${labelOf(el)}` : labelOf(el)}
        selected={sel.has(el.id)}
        color={colorFor(el.pen)}
        penTitle={`Pen: ${penName(el.pen)}`}
        badgeText={badge.text}
        badgeWarn={badge.warn}
        badgeBusy={badge.busy}
        badgeTitle={g?.phase ?? (dirty ? 'edited' : '')}
        editing={editing?.kind === 'element' && editing.id === el.id}
        {...handlers}
      />
    )
  }

  // A clip row: a collapsible header (selects the clip itself — so the Transformer moves the whole
  // composition) over its nested mask + members, recursing for nested clips.
  const renderClipRow = (clipEl: DocElement, depth: number): JSX.Element => {
    const members = membersByClip.get(clipEl.id) ?? []
    const expanded = !collapsedClips.has(clipEl.id)
    const isEditing = editing?.kind === 'element' && editing.id === clipEl.id
    return (
      <li key={clipEl.id} className="flex flex-col gap-0.5">
        <div
          className={cx(
            'group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-sm transition-colors',
            depth > 0 && 'ml-4',
            sel.has(clipEl.id) ? 'border-accent-border bg-accent-subtle' : 'border-transparent hover:bg-bg',
          )}
          onClick={(e) => onRowClick(clipEl.id, e)}
          onMouseEnter={() => setHover(clipEl.id)}
          onMouseLeave={() => setHover(null)}
        >
          <button
            className="rounded p-0.5 text-muted hover:text-text"
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse clip' : 'Expand clip'}
            onClick={(e) => {
              e.stopPropagation()
              toggleClip(clipEl.id)
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <Scissors size={14} className="shrink-0 text-faint" />
          {isEditing ? (
            <input
              autoFocus
              defaultValue={labelOf(clipEl)}
              className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-text outline-none ring-1 ring-accent/50"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => onCommitName(clipEl.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') onCancelRename()
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate"
              onDoubleClick={(e) => {
                e.stopPropagation()
                onStartRename(clipEl.id)
              }}
            >
              {labelOf(clipEl)}
            </span>
          )}
          <span className="shrink-0 text-2xs text-faint">{members.length}</span>
          <button
            className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-text sm:opacity-0 sm:group-hover:opacity-100"
            title="Release clip"
            aria-label="Release clip"
            onClick={(e) => {
              e.stopPropagation()
              unclip(clipEl.id)
            }}
          >
            <Crop size={14} />
          </button>
          <button
            className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-accent-text sm:opacity-0 sm:group-hover:opacity-100"
            title="Delete clip"
            aria-label="Delete clip"
            onClick={(e) => {
              e.stopPropagation()
              removeElement(clipEl.id)
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {expanded && (
          <ul className="flex flex-col gap-0.5">
            {members.map((m) => (m.type === 'clip' ? renderClipRow(m, depth + 1) : renderElement(m, true)))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        <SectionTitle>Elements</SectionTitle>
        <div className="flex items-center gap-1">
          {ungroupIds.length > 0 && (
            <button
              className="rounded p-1 text-muted transition-colors hover:bg-bg hover:text-text"
              title="Ungroup"
              aria-label="Ungroup"
              onClick={() => ungroupIds.forEach(ungroup)}
            >
              <Ungroup size={15} />
            </button>
          )}
          {canGroup && (
            <button
              className="rounded p-1 text-muted transition-colors hover:bg-bg hover:text-text"
              title="Group selection"
              aria-label="Group selection"
              onClick={() => {
                const id = createGroup(selectedEls.map((e) => e.id))
                if (id) setEditing({ kind: 'group', id })
              }}
            >
              <GroupIcon size={15} />
            </button>
          )}
          {canGroup && (
            <button
              className="rounded p-1 text-muted transition-colors hover:bg-bg hover:text-text"
              title="Clip to topmost shape"
              aria-label="Clip to topmost shape"
              onClick={() => clipSelected()}
            >
              <Scissors size={15} />
            </button>
          )}
        </div>
      </div>

      {elements.length > 6 && (
        <div className="relative mb-2">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter elements…"
            className={cx(controlClass, 'pl-7')}
          />
        </div>
      )}

      {/* The row list scrolls on its own (capped) so a big import doesn't push the property editor
          below the fold — the Elements header + filter above stay pinned. */}
      <ul className="-mr-1 flex max-h-[45vh] flex-col gap-0.5 overflow-y-auto pr-1">
        {rows.map((r) => {
          if (r.kind === 'element') return renderElement(r.el, false)
          if (r.kind === 'clip') return renderClipRow(r.el, 0)
          const ids = r.members.map((m) => m.id)
          const allSel = ids.length > 0 && ids.every((i) => sel.has(i))
          const someSel = !allSel && ids.some((i) => sel.has(i))
          const isEditing = editing?.kind === 'group' && editing.id === r.id
          return (
            <li key={r.id} className="flex flex-col gap-0.5">
              <div
                className={cx(
                  'group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-sm transition-colors',
                  allSel
                    ? 'border-accent-border bg-accent-subtle'
                    : someSel
                      ? 'border-accent-border/40 hover:bg-bg'
                      : 'border-transparent hover:bg-bg',
                )}
                onClick={(e) => clickGroup(r.members, e)}
              >
                <button
                  className="rounded p-0.5 text-muted hover:text-text"
                  title={r.expanded ? 'Collapse' : 'Expand'}
                  aria-label={r.expanded ? 'Collapse group' : 'Expand group'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!query.trim()) setGroupCollapsed(r.id, r.expanded)
                  }}
                >
                  {r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <Folder size={14} className="shrink-0 text-faint" />
                {isEditing ? (
                  <input
                    autoFocus
                    defaultValue={r.name}
                    className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-text outline-none ring-1 ring-accent/50"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      renameGroup(r.id, e.target.value.trim() || 'Group')
                      setEditing(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditing({ kind: 'group', id: r.id })
                    }}
                  >
                    {r.name}
                  </span>
                )}
                <span className="shrink-0 text-2xs text-faint">{r.count}</span>
                <button
                  className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-text sm:opacity-0 sm:group-hover:opacity-100"
                  title="Ungroup"
                  aria-label="Ungroup"
                  onClick={(e) => {
                    e.stopPropagation()
                    ungroup(r.id)
                  }}
                >
                  <Ungroup size={14} />
                </button>
              </div>
              {r.expanded && <ul className="flex flex-col gap-0.5">{r.members.map((m) => renderElement(m, true))}</ul>}
            </li>
          )
        })}
      </ul>
    </>
  )
}
