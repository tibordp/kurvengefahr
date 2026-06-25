// Toolbar document control: the current document's (inline-editable) name + a menu for
// New / Duplicate / Delete / Import / Export / Open-recent. Deliberately compact — a fresh tab just
// shows "Untitled" on a blank canvas; nothing here is modal.
import { useEffect, useState } from 'react'
import { ChevronDown, FilePlus, Copy, Trash2, Upload, Download, FileText } from 'lucide-react'
import { useDocuments } from '../store/documents'
import { useDoc } from '../store/document'
import { documentFile, CURRENT_DOC_SCHEMA, type DocSnapshot, type StoredDoc } from '../store/persistence/schema'
import { downloadBlob, pickFile, safeFilename } from '../output/download'
import { exportDocumentContainer, parseDocumentContainer, type ContainerImage } from '../output/container'
import { getImageBlob, putImageBlob, referencedImageIds } from '../store/images'
import { Menu, MenuItem, MenuSeparator, MenuLabel, IconButton, cx } from './primitives'

/** Rewrite each element's `params.imageId` through `idMap` (import re-mints blob ids). */
function remapImageIds(snapshot: DocSnapshot, idMap: Map<string, string>): DocSnapshot {
  if (idMap.size === 0) return snapshot
  return {
    ...snapshot,
    elements: snapshot.elements.map((el) => {
      const p = el.params as { imageId?: unknown }
      if (p && typeof p.imageId === 'string' && idMap.has(p.imageId)) {
        return { ...el, params: { ...(el.params as object), imageId: idMap.get(p.imageId)! } }
      }
      return el
    }),
  }
}

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

  const onExport = async () => {
    const { activeId, activeName, index } = useDocuments.getState()
    const { elements, profile, selectedIds, fiducial } = useDoc.getState()
    const doc: StoredDoc = {
      schemaVersion: CURRENT_DOC_SCHEMA,
      id: activeId,
      name: activeName,
      updatedAt: index.find((m) => m.id === activeId)?.updatedAt ?? Date.now(),
      elements,
      profile,
      selectedIds,
      fiducial,
    }
    // Bundle every referenced image blob alongside the JSON. A missing blob is simply omitted (the
    // element re-imports as a placeholder).
    const images: ContainerImage[] = []
    for (const imageId of referencedImageIds(elements)) {
      const blob = await getImageBlob(imageId)
      if (blob) images.push({ imageId, blob })
    }
    const container = await exportDocumentContainer(documentFile(doc), images)
    downloadBlob(`${safeFilename(activeName, 'kurvengefahr')}.kgz`, container)
  }

  const onImport = async () => {
    try {
      const file = await pickFile('.kgz,application/zip')
      if (!file) return
      const res = await parseDocumentContainer(file)
      if (res.status === 'unsupported') {
        alert(`Can't import — ${res.message}. Try updating the app.`)
        return
      }
      if (res.status !== 'ok') {
        alert('That file is not a valid Kurvengefahr document.')
        return
      }
      // Re-mint each image id (avoid clobbering existing blobs / collisions across files), write the
      // blobs, and remap the snapshot's element params to the new ids before loading.
      const idMap = new Map<string, string>()
      for (const img of res.value.images) {
        const newId = crypto.randomUUID()
        idMap.set(img.imageId, newId)
        await putImageBlob(newId, img.blob)
      }
      const snapshot = remapImageIds(res.value.snapshot, idMap)
      useDocuments.getState().loadImported(res.value.name || 'Imported', snapshot)
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
