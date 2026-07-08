// Toolbar document control: the current document's (inline-editable) name + a menu for
// New / Duplicate / Delete / Import / Export / Open-recent. Deliberately compact — a fresh tab just
// shows "Untitled" on a blank canvas; nothing here is modal.
import { useEffect, useState } from 'react'
import { ChevronDown, FilePlus, Copy, Trash2, Upload, Download, FileText, FolderOpen, Save } from 'lucide-react'
import { importContentFile } from '../canvas/importImage'
import { useExportDialog } from '../store/exportDialog'
import { useDocuments } from '../store/documents'
import { useSaveStatus } from '../store/saveStatus'
import { downloadBlob, pickFile, safeFilename } from '../output/download'
import { exportActiveDocument, importDocumentContainer } from '../output/documentContainer'
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
      className="w-28 min-w-0 truncate rounded bg-transparent px-1.5 py-1 text-sm font-medium text-text outline-none placeholder:text-faint hover:bg-bg focus:bg-surface focus-visible:ring-2 focus-visible:ring-accent/35 sm:w-40"
    />
  )
}

/** A subtle dot that fades in while the active doc has changes not yet autosaved. Occupies a fixed
 *  slot (toggles opacity, not display) so the title never shifts. */
function SaveDot() {
  const dirty = useSaveStatus((s) => s.dirty)
  return (
    <span
      aria-hidden
      title={dirty ? 'Unsaved changes — autosaves continuously' : undefined}
      className={cx(
        'mr-1 h-1.5 w-1.5 shrink-0 rounded-full bg-muted transition-opacity duration-300',
        dirty ? 'opacity-100' : 'opacity-0',
      )}
    />
  )
}

export function DocumentMenu() {
  const index = useDocuments((s) => s.index)
  const activeId = useDocuments((s) => s.activeId)

  const onExport = async () => {
    const container = await exportActiveDocument()
    downloadBlob(`${safeFilename(useDocuments.getState().activeName, 'kurvengefahr')}.kgz`, container)
  }

  const onImport = async () => {
    try {
      const file = await pickFile('.kgz,application/zip')
      if (!file) return
      const res = await importDocumentContainer(file)
      if (res.status === 'unsupported') {
        alert(`Can't import — ${res.message}. Try updating the app.`)
        return
      }
      if (res.status !== 'ok') {
        alert('That file is not a valid Kurvengefahr document.')
        return
      }
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
      <SaveDot />
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
        <MenuItem onClick={onImport}>
          <FolderOpen size={15} /> Open…
        </MenuItem>
        <MenuItem onClick={onExport}>
          <Save size={15} /> Save as…
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => useDocuments.getState().duplicateActive()}>
          <Copy size={15} /> Duplicate
        </MenuItem>
        <MenuItem danger onClick={onDelete}>
          <Trash2 size={15} /> Delete
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void importContentFile()}>
          <Upload size={15} /> Import…
        </MenuItem>
        <MenuItem onClick={() => useExportDialog.getState().set(true)}>
          <Download size={15} /> Export…
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
