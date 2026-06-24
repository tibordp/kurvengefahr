// Toolbar document control: the current document's (inline-editable) name + a menu for
// New / Duplicate / Delete / Import / Export / Open-recent. Deliberately compact — a fresh tab just
// shows "Untitled" on a blank canvas; nothing here is modal.
import { useEffect, useState } from 'react'
import { ChevronDown, FilePlus, Copy, Trash2, Upload, Download, FileText } from 'lucide-react'
import { useDocuments } from '../store/documents'
import { useDoc } from '../store/document'
import { documentFile, parseDocumentFile, CURRENT_DOC_SCHEMA, type StoredDoc } from '../store/persistence/schema'
import { downloadJson, pickJsonFile, safeFilename } from '../output/download'
import { Menu, MenuItem, MenuSeparator, MenuLabel, IconButton, cx } from './primitives'

/** The document title — looks like text, becomes an input on focus, commits on blur / Enter. */
function DocName() {
  const activeName = useDocuments((s) => s.activeName)
  const [text, setText] = useState(activeName)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(activeName)
  }, [activeName, editing])
  return (
    <input
      value={text}
      placeholder="Untitled"
      title="Rename document"
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setEditing(false)
        useDocuments.getState().renameActive(text.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(activeName)
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className="w-28 truncate rounded bg-transparent px-1.5 py-1 text-sm font-medium text-text outline-none placeholder:text-faint hover:bg-bg focus:bg-surface focus-visible:ring-2 focus-visible:ring-accent/35 sm:w-40"
    />
  )
}

export function DocumentMenu() {
  const index = useDocuments((s) => s.index)
  const activeId = useDocuments((s) => s.activeId)

  const onExport = () => {
    const { activeId, activeName, index } = useDocuments.getState()
    const { elements, profile, selectedId } = useDoc.getState()
    const doc: StoredDoc = {
      schemaVersion: CURRENT_DOC_SCHEMA,
      id: activeId,
      name: activeName,
      updatedAt: index.find((m) => m.id === activeId)?.updatedAt ?? Date.now(),
      elements,
      profile,
      selectedId,
    }
    downloadJson(safeFilename(activeName, 'kurvengefahr'), documentFile(doc))
  }

  const onImport = async () => {
    try {
      const raw = await pickJsonFile()
      if (raw == null) return
      const res = parseDocumentFile(raw)
      if (res.status === 'ok') useDocuments.getState().loadImported(res.value.name || 'Imported', res.value.snapshot)
      else if (res.status === 'unsupported') alert(`Can't import — ${res.message}. Try updating the app.`)
      else alert('That file is not a valid Kurvengefahr document.')
    } catch {
      alert('Could not read that file.')
    }
  }

  const onDelete = () => {
    if (!confirm('Delete this document? This cannot be undone.')) return
    useDocuments.getState().deleteDocument(activeId)
  }

  const recent = index.filter((m) => m.id !== activeId).slice(0, 8)

  return (
    <div className="flex min-w-0 items-center">
      <FileText size={15} className="mr-1 hidden shrink-0 text-faint sm:block" />
      <DocName />
      <Menu
        align="left"
        trigger={({ open }) => (
          <IconButton aria-label="Document menu" title="Document menu" className={cx(open && 'bg-bg text-text')}>
            <ChevronDown size={15} />
          </IconButton>
        )}
      >
        <MenuItem onClick={() => useDocuments.getState().newDocument()}>
          <FilePlus size={15} /> New document
        </MenuItem>
        <MenuItem onClick={() => useDocuments.getState().duplicateActive()}>
          <Copy size={15} /> Duplicate
        </MenuItem>
        <MenuItem danger onClick={onDelete}>
          <Trash2 size={15} /> Delete
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onImport}>
          <Upload size={15} /> Import…
        </MenuItem>
        <MenuItem onClick={onExport}>
          <Download size={15} /> Export
        </MenuItem>
        {recent.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Open recent</MenuLabel>
            <div className="max-h-56 overflow-y-auto">
              {recent.map((m) => (
                <MenuItem key={m.id} className="truncate" onClick={() => useDocuments.getState().openDocument(m.id)}>
                  {m.name.trim() || 'Untitled'}
                </MenuItem>
              ))}
            </div>
          </>
        )}
      </Menu>
    </div>
  )
}
