// The Elements tree: every element in the document, organized into flat (non-nesting) groups. The
// reliable way to (re)select things — including an element dragged off the bed or hidden inside a
// collapsed group. Selection here drives the same store as clicking the canvas, both ways. Built for
// many elements (SVG import drops its shapes into one collapsed group): collapse, search, multi-
// select with shift-range and cmd-toggle, group / ungroup, and inline rename.
import { useRef, useState } from 'react'
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
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import { useDoc } from '../store/document'
import { useGeneration, needsManualRegen } from '../core/generation'
import { useHover } from '../store/hover'
import type { DocElement } from '../core/types'
import type { HandwritingParams } from '../elements/handwriting'
import type { PathParams } from '../elements/shapes'
import type { TextParams } from '../elements/text'
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
  if (el.type === 'rect') return 'Rectangle'
  if (el.type === 'ellipse') return 'Ellipse'
  if (el.type === 'path') {
    const p = el.params as PathParams
    const nodeCount = p.contours.reduce((a, c) => a + c.nodes.length, 0)
    const closed = p.contours.length > 0 && p.contours.every((c) => c.closed)
    return `${closed ? 'Shape' : 'Path'} (${nodeCount})`
  }
  if (el.type === 'raster') return 'Image'
  return el.type
}

const labelOf = (el: DocElement) => el.name ?? derivedName(el)

const TYPE_ICON: Record<string, LucideIcon> = {
  handwriting: Signature,
  text: Type,
  rect: Square,
  ellipse: Circle,
  path: Spline,
  raster: ImageIcon,
}

/** The generation badge (loading / generating / error / edited) for an element row. */
function statusBadge(phase: string | undefined, dirty: boolean): { text: string; warn: boolean; busy: boolean } {
  if (phase === 'loading-model') return { text: '⏳', warn: false, busy: true }
  if (phase === 'generating') return { text: '✎', warn: false, busy: true }
  if (phase === 'error') return { text: '⚠', warn: true, busy: false }
  if (dirty) return { text: '●', warn: true, busy: false }
  return { text: '', warn: false, busy: false }
}

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
  const renameGroup = useDoc((s) => s.renameGroup)
  const setGroupCollapsed = useDoc((s) => s.setGroupCollapsed)
  const setElementName = useDoc((s) => s.setElementName)
  const genStatus = useGeneration((s) => s.status)
  const setHover = useHover((s) => s.set)

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ kind: 'element' | 'group'; id: string } | null>(null)
  const anchor = useRef<string | null>(null)

  if (elements.length === 0) return null

  const q = query.trim().toLowerCase()
  const sel = new Set(selectedIds)
  const groupsById = new Map(groups.map((g) => [g.id, g]))
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'

  const matchesEl = (el: DocElement) => !q || labelOf(el).toLowerCase().includes(q) || el.type.includes(q)

  // Members per group, in element-array order.
  const membersByGroup = new Map<string, DocElement[]>()
  for (const el of elements) {
    if (el.groupId && groupsById.has(el.groupId)) {
      const arr = membersByGroup.get(el.groupId) ?? []
      arr.push(el)
      membersByGroup.set(el.groupId, arr)
    }
  }

  // Display rows: top-level order = first appearance of each element/group in the array. Search
  // forces groups open and hides non-matching rows.
  type Row =
    | { kind: 'element'; el: DocElement }
    | { kind: 'group'; id: string; name: string; members: DocElement[]; expanded: boolean }
  const rows: Row[] = []
  const seenGroup = new Set<string>()
  for (const el of elements) {
    if (el.groupId && groupsById.has(el.groupId)) {
      const g = groupsById.get(el.groupId)!
      if (seenGroup.has(g.id)) continue
      seenGroup.add(g.id)
      const all = membersByGroup.get(g.id)!
      const members = q ? all.filter(matchesEl) : all
      const groupMatches = !q || g.name.toLowerCase().includes(q)
      if (q && !groupMatches && members.length === 0) continue
      rows.push({ kind: 'group', id: g.id, name: g.name, members, expanded: q ? true : !g.collapsed })
    } else if (matchesEl(el)) {
      rows.push({ kind: 'element', el })
    }
  }

  // Flattened element ids in display order — the axis for shift-range selection.
  const flatIds: string[] = []
  for (const r of rows) {
    if (r.kind === 'element') flatIds.push(r.el.id)
    else if (r.expanded) for (const m of r.members) flatIds.push(m.id)
  }

  const clickElement = (id: string, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (e.shiftKey && anchor.current) {
      const a = flatIds.indexOf(anchor.current)
      const b = flatIds.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        selectMany(flatIds.slice(lo, hi + 1))
        return
      }
    }
    if (e.metaKey || e.ctrlKey) select(id, true)
    else select(id, false)
    anchor.current = id
  }

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

  const commitName = (val: string) => {
    if (!editing) return
    const name = val.trim()
    if (editing.kind === 'group') renameGroup(editing.id, name || 'Group')
    else setElementName(editing.id, name)
    setEditing(null)
  }

  const NameCell = ({ kind, id, label }: { kind: 'element' | 'group'; id: string; label: string }) =>
    editing && editing.kind === kind && editing.id === id ? (
      <input
        autoFocus
        defaultValue={label}
        className="min-w-0 flex-1 rounded bg-surface px-1 text-sm text-text outline-none ring-1 ring-accent/50"
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => commitName(e.target.value)}
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
          setEditing({ kind, id })
        }}
      >
        {label}
      </span>
    )

  const ElementRow = ({ el, nested }: { el: DocElement; nested?: boolean }) => {
    const g = genStatus[el.id]
    const dirty = !g && needsManualRegen(el.id, el.type, el.params)
    const badge = statusBadge(g?.phase, dirty)
    const Icon = TYPE_ICON[el.type] ?? Spline
    const selected = sel.has(el.id)
    return (
      <li
        key={el.id}
        className={cx(
          'group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors',
          nested && 'ml-4',
          selected ? 'border-accent-border bg-accent-subtle' : 'border-transparent hover:bg-bg',
        )}
        onMouseEnter={() => setHover(el.id)}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => clickElement(el.id, e)}
      >
        <Icon size={14} className="shrink-0 text-faint" />
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: colorFor(el.pen) }}
          title={`Pen: ${pens.find((p) => p.id === el.pen)?.name ?? el.pen}`}
        />
        {NameCell({ kind: 'element', id: el.id, label: labelOf(el) })}
        {badge.text && (
          <span
            className={cx('text-2xs leading-none', badge.busy && 'animate-pulse', badge.warn ? 'text-accent-text' : 'text-muted')}
            title={g?.phase ?? (dirty ? 'edited' : '')}
          >
            {badge.text}
          </span>
        )}
        <button
          className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-accent-text sm:opacity-0 sm:group-hover:opacity-100"
          title="Delete"
          aria-label="Delete element"
          onClick={(e) => {
            e.stopPropagation()
            removeElement(el.id)
          }}
        >
          <Trash2 size={14} />
        </button>
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
          if (r.kind === 'element') return ElementRow({ el: r.el })
          const ids = r.members.map((m) => m.id)
          const allSel = ids.length > 0 && ids.every((i) => sel.has(i))
          const someSel = !allSel && ids.some((i) => sel.has(i))
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
                    if (!q) setGroupCollapsed(r.id, r.expanded)
                  }}
                >
                  {r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <Folder size={14} className="shrink-0 text-faint" />
                {NameCell({ kind: 'group', id: r.id, label: r.name })}
                <span className="shrink-0 text-2xs text-faint">{membersByGroup.get(r.id)?.length ?? 0}</span>
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
              {r.expanded && (
                <ul className="flex flex-col gap-0.5">{r.members.map((m) => ElementRow({ el: m, nested: true }))}</ul>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
