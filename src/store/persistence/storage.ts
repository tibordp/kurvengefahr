// Low-level localStorage / sessionStorage access for documents. Pure leaf module (no store imports)
// so both the documents store and the boot/sync controller can use it without import cycles. All
// reads go through the tolerant schema loaders and never throw.
import { loadStoredDoc, serializeDoc, type StoredDoc } from './schema'

export interface DocMeta {
  id: string
  name: string
  updatedAt: number
}

export const INDEX_KEY = 'kg-docs'
export const ACTIVE_KEY = 'kg-active' // sessionStorage: this tab's active document id
export const docKey = (id: string) => `kg-doc:${id}`

export function readDoc(id: string): StoredDoc | null {
  try {
    const raw = localStorage.getItem(docKey(id))
    if (!raw) return null
    const res = loadStoredDoc(JSON.parse(raw))
    if (res.status === 'ok') return res.value
    if (res.status === 'unsupported') console.warn(`[kg] doc ${id}: ${res.message}; leaving stored bytes untouched`)
    else console.warn(`[kg] doc ${id}: ${res.message}`)
    return null
  } catch {
    return null
  }
}

/** Serialize a doc to its canonical storage string (without writing). */
export function docPayload(doc: StoredDoc): string {
  return JSON.stringify(serializeDoc(doc))
}

export function writeDocRaw(id: string, payload: string): void {
  try {
    localStorage.setItem(docKey(id), payload)
  } catch (e) {
    console.warn('[kg] failed to persist document', e)
  }
}

export function removeDoc(id: string): void {
  try {
    localStorage.removeItem(docKey(id))
  } catch {
    /* ignore */
  }
}

export function readIndex(): DocMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((m) => m && typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        name: typeof m.name === 'string' ? m.name : '',
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
      }))
  } catch {
    return []
  }
}

export function writeIndex(index: DocMeta[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index))
  } catch (e) {
    console.warn('[kg] failed to persist document index', e)
  }
}

export function getActiveId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function setActiveId(id: string): void {
  try {
    sessionStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}
