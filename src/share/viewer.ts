// Share-viewer boot: fetch → verify hash → decrypt → parse → stage → load into `useDoc`, plus
// "Edit a copy". The viewer deliberately never calls initDocuments()/loadImported() — no
// autosave wiring, no index entry, zero localStorage writes — so opening a link can't litter the
// visitor's browser. `useDoc.loadDocument` alone persists nothing; the generation manager then
// regenerates worker-backed elements exactly as it would for a freshly opened document.
//
// Images are the one unavoidable side effect: the vectorize/model workers fetch blobs from
// IndexedDB by id, so a shared doc's images must be staged there (freshly minted ids, like
// import). Until "Edit a copy" they're referenced by no stored document, which makes them
// orphans to `documents.ts`'s boot-time image sweep — the *next* editor boot GCs them. Known
// race we accept: another tab booting the editor mid-viewing can sweep them early; geometry
// already on canvas survives, only a re-trace would fail.
import { create } from 'zustand'
import { parseDocumentContainer } from '../output/container'
import { stageContainerImport } from '../output/documentContainer'
import { useDoc } from '../store/document'
import { CURRENT_DOC_SCHEMA, type DocSnapshot, type StoredDoc } from '../store/persistence/schema'
import { docPayload, readIndex, setActiveId, writeDocRaw, writeIndex } from '../store/persistence/storage'
import { SHARE_API_URL } from './config'
import { decryptContainer, sha256, toBase64Url } from './crypto'
import type { ShareRef } from './link'
import { ShareApiError, fetchBlob } from './service'

export type ViewerErrorKind =
  | 'unavailable' // this build has sharing compiled out
  | 'insecure' // no WebCrypto (plain-HTTP LAN origin) — can't decrypt
  | 'bad-link' // #s= fragment present but malformed (usually truncated on copy)
  | 'not-found' // the API has no such blob: never existed, or expired via the lifecycle rule
  | 'wrong-key' // blob fetched + hash-verified, but the link's key fails GCM auth
  | 'corrupt' // bytes that were never a valid encrypted container (or a lying server)
  | 'network'

export type ViewerState =
  | { phase: 'loading'; step: 'fetching' | 'decrypting' | 'preparing' }
  | { phase: 'ready'; name: string }
  | { phase: 'error'; kind: ViewerErrorKind }

interface ViewerStore {
  state: ViewerState
  _set: (state: ViewerState) => void
}

export const useViewer = create<ViewerStore>((set) => ({
  state: { phase: 'loading', step: 'fetching' },
  _set: (state) => set({ state }),
}))

/** The staged (decrypted, image-remapped) document, kept for `saveViewerCopy`. */
let staged: { name: string; snapshot: DocSnapshot } | null = null

export async function bootViewer(ref: ShareRef | 'invalid'): Promise<void> {
  const set = useViewer.getState()._set
  const fail = (kind: ViewerErrorKind) => set({ phase: 'error', kind })
  if (ref === 'invalid') return fail('bad-link')
  if (!SHARE_API_URL) return fail('unavailable')
  if (typeof crypto === 'undefined' || !crypto.subtle) return fail('insecure')

  set({ phase: 'loading', step: 'fetching' })
  let stored: Uint8Array
  try {
    stored = await fetchBlob(ref.hash)
  } catch (err) {
    return fail(err instanceof ShareApiError && err.kind === 'not-found' ? 'not-found' : 'network')
  }

  set({ phase: 'loading', step: 'decrypting' })
  // Content addressing means we can verify the server's bytes before trusting them at all.
  if (toBase64Url(await sha256(stored)) !== ref.hash) return fail('corrupt')
  const dec = await decryptContainer(stored, ref.key)
  if (dec.status !== 'ok') return fail(dec.status)
  const parsed = await parseDocumentContainer(new Blob([dec.plain as BlobPart]))
  if (parsed.status !== 'ok') return fail('corrupt')

  set({ phase: 'loading', step: 'preparing' })
  staged = await stageContainerImport(parsed.value)
  useDoc.getState().loadDocument({ ...staged.snapshot, selectedIds: [] })
  set({ phase: 'ready', name: staged.name })
}

/** Persist the viewed snapshot as a real local document, bind this tab to it, and reload into
 *  the normal editor. The reload (which also drops the share fragment) guarantees zero viewer
 *  residue — workers, generation caches, module state — and `initDocuments()` boots already
 *  attached to the new document; its image sweep then sees the staged blobs as referenced. */
export async function saveViewerCopy(): Promise<void> {
  if (!staged) throw new Error('no shared document loaded')
  const doc: StoredDoc = {
    schemaVersion: CURRENT_DOC_SCHEMA,
    id: crypto.randomUUID(),
    name: staged.name,
    updatedAt: Date.now(),
    ...staged.snapshot,
    selectedIds: [],
  }
  writeDocRaw(doc.id, docPayload(doc))
  writeIndex([
    { id: doc.id, name: doc.name, updatedAt: doc.updatedAt },
    ...readIndex().filter((m) => m.id !== doc.id),
  ])
  setActiveId(doc.id)
  location.replace(location.pathname)
}

/** Test-only: reset module state. */
export function resetViewerForTests(): void {
  staged = null
  useViewer.getState()._set({ phase: 'loading', step: 'fetching' })
}
