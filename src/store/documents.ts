// The documents store + persistence wiring. Each browser tab is bound to one document (its id lives
// in sessionStorage), so two tabs edit two different `kg-doc:<id>` keys and never clash. Editing
// autosaves (debounced, content-diffed); a fresh tab starts on a blank, unsaved canvas.
//
// Same document open in two tabs (a duplicated tab) → live sync + last-write-wins via `storage`
// events, with an echo guard (don't re-save what we just received) and a focus guard (don't yank a
// textarea out from under an active edit).
import { create } from 'zustand'
import { PRUSA_MK4 } from './profiles'
import { useDoc } from './document'
import { type DocSnapshot, type StoredDoc, CURRENT_DOC_SCHEMA, loadStoredDoc } from './persistence/schema'
import * as storage from './persistence/storage'
import type { DocMeta } from './persistence/storage'

const emptySnapshot = (): DocSnapshot => ({
  elements: [],
  profile: structuredClone(PRUSA_MK4),
  selectedId: null,
})

interface DocsStore {
  index: DocMeta[]
  activeId: string
  activeName: string

  newDocument: () => void
  openDocument: (id: string) => void
  deleteDocument: (id: string) => void
  renameActive: (name: string) => void
  duplicateActive: () => void
  /** Bind a fresh document to this tab from imported content. */
  loadImported: (name: string, snapshot: DocSnapshot) => void

  _setIndex: (index: DocMeta[]) => void
}

export const useDocuments = create<DocsStore>((set, get) => ({
  index: [],
  activeId: '',
  activeName: '',

  newDocument: () => {
    const id = crypto.randomUUID()
    storage.setActiveId(id)
    useDoc.getState().loadDocument(emptySnapshot())
    set({ activeId: id, activeName: '' })
    lastContent = contentKey() // blank + not in index → autosave won't persist until first edit
  },

  openDocument: (id) => {
    const doc = storage.readDoc(id)
    if (!doc) return
    storage.setActiveId(id)
    useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedId: doc.selectedId })
    set({ activeId: id, activeName: doc.name })
    lastContent = contentKey() // matches storage → no redundant rewrite
  },

  deleteDocument: (id) => {
    storage.removeDoc(id)
    const index = get().index.filter((m) => m.id !== id)
    storage.writeIndex(index)
    set({ index })
    if (id === get().activeId) get().newDocument()
  },

  renameActive: (name) => {
    set({ activeName: name })
    persistActive()
  },

  duplicateActive: () => {
    const id = crypto.randomUUID()
    const name = `${get().activeName.trim() || 'Untitled'} copy`
    storage.setActiveId(id)
    set({ activeId: id, activeName: name }) // working canvas (useDoc) is unchanged — just a new identity
    lastContent = null
    persistActive({ force: true })
  },

  loadImported: (name, snapshot) => {
    const id = crypto.randomUUID()
    storage.setActiveId(id)
    useDoc.getState().loadDocument(snapshot)
    set({ activeId: id, activeName: name })
    lastContent = null
    persistActive({ force: true })
  },

  _setIndex: (index) => set({ index }),
}))

// ---- autosave + cross-tab sync ------------------------------------------------------------------

// Content fingerprint of the active doc, EXCLUDING updatedAt (which changes every save and would
// defeat the diff). A no-op `notifyGeometry()` re-render produces an identical key → skipped.
function contentKey(): string {
  const { activeName } = useDocuments.getState()
  const { elements, profile, selectedId } = useDoc.getState()
  return JSON.stringify({ activeName, elements, profile, selectedId })
}

let lastContent: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pendingRemote: StoredDoc | null = null

/** A blank, never-saved doc isn't worth a storage entry until it has real content (no litter). */
function worthPersisting(): boolean {
  const { activeId, activeName, index } = useDocuments.getState()
  return (
    useDoc.getState().elements.length > 0 ||
    activeName.trim() !== '' ||
    index.some((m) => m.id === activeId)
  )
}

function upsert(index: DocMeta[], meta: DocMeta): DocMeta[] {
  const rest = index.filter((m) => m.id !== meta.id)
  return [meta, ...rest]
}

function persistActive(opts?: { force?: boolean }): void {
  if (!opts?.force && !worthPersisting()) return
  const key = contentKey()
  if (key === lastContent) return // nothing actually changed (e.g. a geometry-only re-render)
  lastContent = key

  const { activeId, activeName } = useDocuments.getState()
  const { elements, profile, selectedId } = useDoc.getState()
  const doc: StoredDoc = {
    schemaVersion: CURRENT_DOC_SCHEMA,
    id: activeId,
    name: activeName,
    updatedAt: Date.now(),
    elements,
    profile,
    selectedId,
  }
  storage.writeDocRaw(activeId, storage.docPayload(doc))
  const index = upsert(useDocuments.getState().index, { id: activeId, name: activeName, updatedAt: doc.updatedAt })
  storage.writeIndex(index)
  useDocuments.getState()._setIndex(index)
}

function isEditingText(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function applyRemote(doc: StoredDoc): void {
  useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedId: doc.selectedId })
  useDocuments.setState({ activeName: doc.name })
  lastContent = contentKey() // echo guard: our own autosave now sees no change
  pendingRemote = null
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true

  // Autosave: any change to the working document schedules a debounced, content-diffed save.
  useDoc.subscribe(() => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => persistActive(), 500)
  })

  window.addEventListener('storage', (e) => {
    if (e.key === storage.INDEX_KEY) {
      useDocuments.getState()._setIndex(storage.readIndex())
      return
    }
    // Another tab changed *our* document → last-write-wins sync.
    if (e.key === storage.docKey(useDocuments.getState().activeId) && e.newValue) {
      try {
        const res = loadStoredDoc(JSON.parse(e.newValue))
        if (res.status !== 'ok') return
        if (isEditingText()) pendingRemote = res.value // defer; don't clobber an active edit
        else applyRemote(res.value)
      } catch {
        /* ignore malformed cross-tab payloads */
      }
    }
  })

  // Flush a deferred remote update once the user stops editing.
  window.addEventListener('focusout', () => {
    if (pendingRemote && !isEditingText()) applyRemote(pendingRemote)
  })
}

/** Boot persistence: reattach this tab to its document (or start a blank one) and start autosaving.
 *  Call once before first render. */
export function initDocuments(): void {
  const index = storage.readIndex()
  const activeId = storage.getActiveId()
  if (activeId) {
    const doc = storage.readDoc(activeId)
    if (doc) {
      useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedId: doc.selectedId })
      useDocuments.setState({ index, activeId, activeName: doc.name })
      lastContent = contentKey()
      wire()
      return
    }
  }
  // Fresh tab (or the bound doc vanished) → blank canvas, bound but not yet persisted.
  const id = crypto.randomUUID()
  storage.setActiveId(id)
  useDoc.getState().loadDocument(emptySnapshot())
  useDocuments.setState({ index, activeId: id, activeName: '' })
  lastContent = contentKey()
  wire()
}
