// The Elements tree: every element in the document, organized into nesting containers (group / clip).
// The reliable way to (re)select things — including an element dragged off the bed or hidden inside a
// collapsed container. Selection here drives the same store as clicking the canvas, both ways. Built
// for many elements (SVG import drops its shapes into one container): collapse, search, multi-select
// with shift-range and cmd-toggle, group / ungroup / clip / release, and inline rename.
//
// Perf: the document/query → row-list computation is memoized, the per-element rows are a memoized
// component, and handlers are stable — so a generation tick (which re-renders the whole tree via the
// shared `genStatus`) or a selection change re-renders only the rows that actually changed.
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
import { isContainer } from '../elements/registry'
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
  if (el.type === 'group') return 'Group'
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
  group: Folder,
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

type Row = { kind: 'element'; el: DocElement } | { kind: 'container'; el: DocElement }

export function ElementsTree() {
  const elements = useDoc((s) => s.elements)
  const selectedIds = useDoc((s) => s.selectedIds)
  const pens = useDoc((s) => s.profile.pens)
  const select = useDoc((s) => s.select)
  const selectMany = useDoc((s) => s.selectMany)
  const removeElement = useDoc((s) => s.removeElement)
  const createGroup = useDoc((s) => s.createGroup)
  const ungroup = useDoc((s) => s.ungroup)
  const clipSelected = useDoc((s) => s.clipSelected)
  const setElementName = useDoc((s) => s.setElementName)
  const unclip = useDoc((s) => s.unclip)
  const genStatus = useGeneration((s) => s.status)
  const setHover = useHover((s) => s.set)

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  // Containers track their expand state locally (it isn't persisted).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleContainer = useCallback(
    (id: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      }),
    [],
  )
  const anchor = useRef<string | null>(null)

  // Row list depends only on the document + filter — memoized so a selection change or a generation
  // tick (which re-renders this component) doesn't recompute the whole O(n) grouping.
  const { rows, flatIds, membersByContainer } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchesEl = (el: DocElement) => !q || labelOf(el).toLowerCase().includes(q) || el.type.includes(q)

    const containerIds = new Set(elements.filter((e) => isContainer(e.type)).map((e) => e.id))
    const membersByContainer = new Map<string, DocElement[]>()
    for (const el of elements)
      if (el.parent && containerIds.has(el.parent)) {
        const arr = membersByContainer.get(el.parent) ?? []
        arr.push(el)
        membersByContainer.set(el.parent, arr)
      }

    // A container matches the query if it (or any descendant) matches — so search reveals nested hits.
    const containerMatches = (el: DocElement): boolean => {
      if (matchesEl(el)) return true
      return (membersByContainer.get(el.id) ?? []).some((m) => (isContainer(m.type) ? containerMatches(m) : matchesEl(m)))
    }

    const out: Row[] = []
    for (const el of elements) {
      if (el.parent && containerIds.has(el.parent)) continue // shown nested under its container
      if (isContainer(el.type)) {
        if (!q || containerMatches(el)) out.push({ kind: 'container', el })
      } else if (matchesEl(el)) {
        out.push({ kind: 'element', el })
      }
    }

    // Flat order (for shift-range select), recursing into expanded containers.
    const flat: string[] = []
    const pushContainer = (el: DocElement) => {
      flat.push(el.id)
      if (!q && collapsed.has(el.id)) return
      for (const m of membersByContainer.get(el.id) ?? []) (isContainer(m.type) ? pushContainer(m) : flat.push(m.id))
    }
    for (const r of out) (r.kind === 'container' ? pushContainer(r.el) : flat.push(r.el.id))
    return { rows: out, flatIds: flat, membersByContainer }
  }, [elements, query, collapsed])

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
  const onStartRename = useCallback((id: string) => setEditing(id), [])
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

  // Header actions over the current selection.
  const selectedEls = elements.filter((e) => sel.has(e.id))
  const canGroup = selectedEls.length >= 2
  const ungroupIds = selectedEls.filter((e) => e.type === 'group').map((e) => e.id)

  const renderElement = (el: DocElement) => {
    const g = genStatus[el.id]
    const dirty = !g && needsManualRegen(el.id, el.type, el.params)
    const badge = statusBadge(g?.phase, dirty)
    return (
      <ElementRow
        key={el.id}
        el={el}
        label={el.clipRole === 'mask' ? `Mask · ${labelOf(el)}` : labelOf(el)}
        selected={sel.has(el.id)}
        color={colorFor(el.pen)}
        penTitle={`Pen: ${penName(el.pen)}`}
        badgeText={badge.text}
        badgeWarn={badge.warn}
        badgeBusy={badge.busy}
        badgeTitle={g?.phase ?? (dirty ? 'edited' : '')}
        editing={editing === el.id}
        {...handlers}
      />
    )
  }

  // A container row: a collapsible header (selects the container itself — so the Transformer moves the
  // whole composition) over its nested members, recursing for nested containers. A clip additionally
  // shows a Release action; a group shows Ungroup.
  const renderContainerRow = (el: DocElement): JSX.Element => {
    const members = membersByContainer.get(el.id) ?? []
    const expanded = !!query.trim() || !collapsed.has(el.id)
    const isEditing = editing === el.id
    const isClip = el.type === 'clip'
    const ContainerIcon = isClip ? Scissors : Folder
    return (
      <li key={el.id} className="flex flex-col gap-0.5">
        <div
          className={cx(
            'group flex cursor-pointer items-center gap-1.5 rounded-md border px-1.5 py-1.5 text-sm transition-colors',
            sel.has(el.id) ? 'border-accent-border bg-accent-subtle' : 'border-transparent hover:bg-bg',
          )}
          onClick={(e) => onRowClick(el.id, e)}
          onMouseEnter={() => setHover(el.id)}
          onMouseLeave={() => setHover(null)}
        >
          <button
            className="rounded p-0.5 text-muted hover:text-text"
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation()
              if (!query.trim()) toggleContainer(el.id)
            }}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <ContainerIcon size={14} className="shrink-0 text-faint" />
          {isEditing ? (
            <input
              autoFocus
              defaultValue={labelOf(el)}
              className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-text outline-none ring-1 ring-accent/50"
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => onCommitName(el.id, e.target.value)}
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
                onStartRename(el.id)
              }}
            >
              {labelOf(el)}
            </span>
          )}
          <span className="shrink-0 text-2xs text-faint">{members.length}</span>
          <button
            className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-text sm:opacity-0 sm:group-hover:opacity-100"
            title={isClip ? 'Release clip' : 'Ungroup'}
            aria-label={isClip ? 'Release clip' : 'Ungroup'}
            onClick={(e) => {
              e.stopPropagation()
              isClip ? unclip(el.id) : ungroup(el.id)
            }}
          >
            {isClip ? <Crop size={14} /> : <Ungroup size={14} />}
          </button>
          <button
            className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-accent-text sm:opacity-0 sm:group-hover:opacity-100"
            title={isClip ? 'Delete clip' : 'Delete group'}
            aria-label={isClip ? 'Delete clip' : 'Delete group'}
            onClick={(e) => {
              e.stopPropagation()
              removeElement(el.id)
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
        {expanded && (
          // Indent + a guide rule per nesting level — depth accumulates through the DOM, so 2nd- and
          // 3rd-level items sit at their true depth (not a single flat indent).
          <ul className="ml-3 flex flex-col gap-0.5 border-l border-border/60 pl-1">
            {members.map((m) => (isContainer(m.type) ? renderContainerRow(m) : renderElement(m)))}
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
                if (id) setEditing(id)
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
        {rows.map((r) => (r.kind === 'element' ? renderElement(r.el) : renderContainerRow(r.el)))}
      </ul>
    </>
  )
}
