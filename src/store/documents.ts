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
import { reset as resetHistory, wireHistory, leave as leaveHistory, enter as enterHistory } from './history'
import { type DocSnapshot, type StoredDoc, CURRENT_DOC_SCHEMA, loadStoredDoc } from './persistence/schema'
import * as storage from './persistence/storage'
import type { DocMeta } from './persistence/storage'

const emptySnapshot = (): DocSnapshot => ({
  elements: [],
  profile: structuredClone(PRUSA_MK4),
  selectedIds: [],
  fiducial: null,
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
    const prev = get().activeId
    flushSave()
    leaveHistory(prev) // stash the outgoing doc's undo stack before we replace the canvas
    const id = crypto.randomUUID()
    storage.setActiveId(id)
    useDoc.getState().loadDocument(emptySnapshot())
    set({ activeId: id, activeName: '' })
    lastContent = contentKey() // blank + not in index → autosave won't persist until first edit
    enterHistory(id)
  },

  openDocument: (id) => {
    const doc = storage.readDoc(id)
    if (!doc) return
    const prev = get().activeId
    flushSave()
    leaveHistory(prev)
    storage.setActiveId(id)
    useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedIds: doc.selectedIds, fiducial: doc.fiducial })
    set({ activeId: id, activeName: doc.name })
    lastContent = contentKey() // matches storage → no redundant rewrite
    enterHistory(id) // restore this doc's stack if it's still valid for the loaded content
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
    const prev = get().activeId
    flushSave()
    leaveHistory(prev)
    const id = crypto.randomUUID()
    storage.setActiveId(id)
    useDoc.getState().loadDocument(snapshot)
    set({ activeId: id, activeName: name })
    lastContent = null
    persistActive({ force: true })
    enterHistory(id)
  },

  _setIndex: (index) => set({ index }),
}))

// ---- autosave + cross-tab sync ------------------------------------------------------------------

// Content fingerprint of the active doc, EXCLUDING updatedAt (which changes every save and would
// defeat the diff). A no-op `notifyGeometry()` re-render produces an identical key → skipped.
function contentKey(): string {
  const { activeName } = useDocuments.getState()
  const { elements, profile, selectedIds, fiducial } = useDoc.getState()
  return JSON.stringify({ activeName, elements, profile, selectedIds, fiducial })
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
  const { elements, profile, selectedIds, fiducial } = useDoc.getState()
  const doc: StoredDoc = {
    schemaVersion: CURRENT_DOC_SCHEMA,
    id: activeId,
    name: activeName,
    updatedAt: Date.now(),
    elements,
    profile,
    selectedIds,
    fiducial,
  }
  storage.writeDocRaw(activeId, storage.docPayload(doc))
  const index = upsert(useDocuments.getState().index, { id: activeId, name: activeName, updatedAt: doc.updatedAt })
  storage.writeIndex(index)
  useDocuments.getState()._setIndex(index)
}

/** Force any pending debounced autosave to flush synchronously. Called when leaving a document
 *  state (switch / hide / close) so localStorage matches the in-memory doc — which is what the
 *  persisted undo stack is fingerprinted against, and closes the 500 ms close-the-tab loss window. */
function flushSave(): void {
  clearTimeout(saveTimer)
  persistActive()
}

function isEditingText(): boolean {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function applyRemote(doc: StoredDoc): void {
  useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedIds: doc.selectedIds, fiducial: doc.fiducial })
  useDocuments.setState({ activeName: doc.name })
  lastContent = contentKey() // echo guard: our own autosave now sees no change
  pendingRemote = null
  resetHistory() // the remote state is the new baseline; don't let it be undone locally
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

  // Undo/redo: capture document changes into the history stack (+ the field-edit focus bracket).
  wireHistory()

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

  // Leaving the tab (hide/close/refresh): flush the doc + stash its undo stack so a refresh or a
  // bfcache back-navigation can restore both. `visibilitychange→hidden` is the reliable last
  // callback on mobile; `pagehide` covers desktop close/refresh and is bfcache-friendly.
  const onLeave = () => {
    flushSave()
    leaveHistory(useDocuments.getState().activeId)
  }
  window.addEventListener('pagehide', onLeave)
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave()
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
      useDoc.getState().loadDocument({ elements: doc.elements, profile: doc.profile, selectedIds: doc.selectedIds, fiducial: doc.fiducial })
      useDocuments.setState({ index, activeId, activeName: doc.name })
      lastContent = contentKey()
      wire()
      enterHistory(activeId) // restore this tab's undo stack across a refresh, if still valid
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
  enterHistory(id)
}
