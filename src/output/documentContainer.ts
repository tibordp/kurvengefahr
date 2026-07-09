// App-level `.kgz` glue: the stores ↔ container-format seam. `container.ts` owns the pure file
// format; this module binds it to the live document — importing a container as a new document
// (re-minting image ids so blobs never clobber across files) and exporting the active document
// with its referenced image blobs. Used by the Document menu and the public browser API.
import { exportDocumentContainer, parseDocumentContainer, type ContainerImage } from './container'
import { BLOB_PARAM_KEYS, getImageBlob, putImageBlob, referencedImageIds } from '../store/images'
import { useDocuments } from '../store/documents'
import { useDoc } from '../store/document'
import { documentFile, CURRENT_DOC_SCHEMA, type DocSnapshot, type StoredDoc } from '../store/persistence/schema'

export type ImportDocumentResult = { status: 'ok' } | { status: 'unsupported' | 'invalid'; message: string }

/** Rewrite each element's blob-referencing params (`BLOB_PARAM_KEYS`) through `idMap` (import
 *  re-mints blob ids). */
function remapImageIds(snapshot: DocSnapshot, idMap: Map<string, string>): DocSnapshot {
  if (idMap.size === 0) return snapshot
  return {
    ...snapshot,
    elements: snapshot.elements.map((el) => {
      const p = el.params as Record<string, unknown> | null
      if (!p) return el
      let patch: Record<string, string> | null = null
      for (const key of BLOB_PARAM_KEYS) {
        const v = p[key]
        if (typeof v === 'string' && idMap.has(v)) (patch ??= {})[key] = idMap.get(v)!
      }
      return patch ? { ...el, params: { ...p, ...patch } } : el
    }),
  }
}

/** Import a `.kgz` Blob as a new document bound to this tab. Total — never throws. */
export async function importDocumentContainer(file: Blob): Promise<ImportDocumentResult> {
  const res = await parseDocumentContainer(file)
  if (res.status !== 'ok') return res
  const idMap = new Map<string, string>()
  for (const img of res.value.images) {
    const newId = crypto.randomUUID()
    idMap.set(img.imageId, newId)
    await putImageBlob(newId, img.blob)
  }
  const snapshot = remapImageIds(res.value.snapshot, idMap)
  useDocuments.getState().loadImported(res.value.name || 'Imported', snapshot)
  return { status: 'ok' }
}

/** The active document as its file envelope — the same JSON as `document.json` inside a `.kgz`. */
export function activeDocumentFile(): ReturnType<typeof documentFile> {
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
  return documentFile(doc)
}

/** Build the active document's `.kgz` container Blob (document JSON + every referenced image blob;
 *  a missing blob is simply omitted — the element re-imports as a placeholder). */
export async function exportActiveDocument(): Promise<Blob> {
  const images: ContainerImage[] = []
  for (const imageId of referencedImageIds(useDoc.getState().elements)) {
    const blob = await getImageBlob(imageId)
    if (blob) images.push({ imageId, blob })
  }
  return exportDocumentContainer(activeDocumentFile(), images)
}
