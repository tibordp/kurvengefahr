// Command palette (⌘/Ctrl+K): a fuzzy-searchable list of actions. Commands are built from current
// state each time it opens (so `when` gating reflects the selection); running one closes it.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCommandPalette } from '../store/commandPalette'
import { useTools } from '../store/tools'
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { useViewport } from '../store/viewport'
import { useTheme } from '../store/theme'
import { useUI } from '../store/ui'
import { useExportDialog } from '../store/exportDialog'
import { undo, redo } from '../store/history'
import { exportGcode } from '../output/export'
import { importContentFile } from '../canvas/importImage'
import { copySelectionToClipboard, cutSelectionToClipboard, pasteFromClipboard } from '../store/clipboard'
import { TOOLS } from './shortcuts'
import { controlClass, cx } from './primitives'
import type { PathParams } from '../elements/shapes'

interface Command {
  id: string
  label: string
  group: string
  run: () => void
}

/** Build the command list from current state (selection gating, etc.). */
function buildCommands(): Command[] {
  const doc = useDoc.getState()
  const sel = doc.elements.filter((e) => doc.selectedIds.includes(e.id))
  const hasSel = sel.length > 0
  const closed = sel.filter(
    (e) =>
      e.type === 'rect' ||
      e.type === 'ellipse' ||
      (e.type === 'path' && (e.params as PathParams).contours.some((c) => c.closed && c.nodes.length >= 3)),
  )
  const groupIds = [...new Set(sel.map((e) => e.groupId).filter((g): g is string => !!g))]
  const cmds: Command[] = []
  const add = (id: string, label: string, group: string, run: () => void) => cmds.push({ id, label, group, run })

  for (const t of TOOLS) add(`tool-${t.tool}`, `Tool: ${t.label}`, 'Tools', () => useTools.getState().setTool(t.tool))

  add('fit-all', 'Fit to bed', 'View', () => useViewport.getState().requestFit('all'))
  if (hasSel) add('fit-sel', 'Fit to selection', 'View', () => useViewport.getState().requestFit('selection'))

  add('undo', 'Undo', 'Edit', undo)
  add('redo', 'Redo', 'Edit', redo)
  add('select-all', 'Select all', 'Edit', () => doc.selectMany(doc.elements.map((e) => e.id)))
  if (hasSel) {
    add('dup', 'Duplicate selection', 'Edit', doc.duplicateSelected)
    add('dup-new', 'Duplicate to new document', 'Edit', useDocuments.getState().duplicateSelectionToNewDoc)
    add('delete', 'Delete selection', 'Edit', doc.removeSelected)
    add('copy', 'Copy', 'Edit', () => void copySelectionToClipboard())
    add('cut', 'Cut', 'Edit', () => void cutSelectionToClipboard())
  }
  add('paste', 'Paste', 'Edit', () => void pasteFromClipboard())
  if (sel.length >= 2) add('join', 'Join into one path', 'Combine', doc.joinSelected)
  if (sel.some((e) => e.type === 'path' && (e.params as PathParams).contours.some((c) => !c.closed)))
    add('weld', 'Merge open contours', 'Combine', doc.weldSelected)
  if (sel.some((e) => e.type === 'path' && (e.params as PathParams).contours.length > 1))
    add('break', 'Break apart path', 'Combine', doc.breakApartSelected)
  if (sel.length >= 2) add('group', 'Group selection', 'Arrange', () => doc.createGroup(doc.selectedIds))
  if (groupIds.length) add('ungroup', 'Ungroup', 'Arrange', () => groupIds.forEach(doc.ungroup))
  if (sel.some((e) => e.type !== 'path')) add('to-path', 'Convert to path', 'Arrange', () => doc.convertToPath())
  if (closed.length >= 2) {
    add('bool-union', 'Union', 'Combine', () => doc.booleanSelected(0))
    add('bool-sub', 'Subtract', 'Combine', () => doc.booleanSelected(2))
    add('bool-int', 'Intersect', 'Combine', () => doc.booleanSelected(1))
    add('bool-xor', 'Exclude', 'Combine', () => doc.booleanSelected(3))
  }

  add('new-doc', 'New document', 'File', () => useDocuments.getState().newDocument())
  add('import', 'Import…', 'File', () => void importContentFile())
  add('export', 'Export…', 'File', () => useExportDialog.getState().set(true))
  add('gcode', 'Generate G-code', 'File', () => void exportGcode())

  for (const th of ['light', 'dark', 'system'] as const)
    add(`theme-${th}`, `Theme: ${th[0].toUpperCase() + th.slice(1)}`, 'View', () => useTheme.getState().setTheme(th))
  add('help', 'Keyboard shortcuts', 'Help', () => useUI.getState().toggleHelp())

  return cmds
}

/** Subsequence fuzzy score (lower = better), or null if `q` isn't a subsequence of `s`. */
function score(q: string, s: string): number | null {
  if (!q) return 0
  const ql = q.toLowerCase()
  const sl = s.toLowerCase()
  let si = 0
  let total = 0
  let streak = 0
  for (const c of ql) {
    const idx = sl.indexOf(c, si)
    if (idx === -1) return null
    total += idx === si ? Math.max(0, 4 - streak++) : ((streak = 0), idx + 4)
    si = idx + 1
  }
  return total
}

export function CommandPalette() {
  const open = useCommandPalette((s) => s.open)
  const close = () => useCommandPalette.getState().set(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Rebuild the command list whenever the palette opens (captures current selection state).
  const commands = useMemo(() => (open ? buildCommands() : []), [open])
  const filtered = useMemo(() => {
    if (!q.trim()) return commands
    return commands
      .map((c) => ({ c, s: score(q.trim(), c.label) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => (a.s as number) - (b.s as number))
      .map((x) => x.c)
  }, [commands, q])

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
    }
  }, [open])
  useEffect(() => setActive(0), [q])

  if (!open) return null

  const run = (c: Command | undefined) => {
    if (!c) return
    close()
    c.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={close}>
      <div
        className="w-[min(34rem,92vw)] overflow-hidden rounded-xl border border-border bg-surface shadow-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          placeholder="Type a command…"
          className={cx(controlClass, 'h-11 rounded-none border-0 border-b border-border text-base')}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[active])
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1">
          {filtered.length === 0 && <p className="px-3 py-4 text-sm text-muted">No matching commands.</p>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={cx(
                'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm',
                i === active ? 'bg-accent-subtle text-text' : 'text-text hover:bg-bg',
              )}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="truncate">{c.label}</span>
              <span className="shrink-0 text-2xs text-faint">{c.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
