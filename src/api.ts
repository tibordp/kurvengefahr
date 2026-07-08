// The public browser API: a small, stable surface on `window.kurvengefahr` for userscripts,
// browser extensions, and headless automation (docs/screenshot.mjs). Installed unconditionally at
// boot (main.tsx). Keep it small and additive — every published member is a compatibility promise.
import { importDocumentContainer, exportActiveDocument, type ImportDocumentResult } from './output/documentContainer'
import { useDoc } from './store/document'
import { useGeneration } from './core/generation'
import { getCached, isAsyncType } from './elements/registry'
import { useViewport } from './store/viewport'

export interface KurvengefahrApi {
  /** Import a `.kgz` container as a new document (binds this tab to it). Never throws. */
  importDocument: (data: ArrayBuffer | Uint8Array<ArrayBuffer> | Blob) => Promise<ImportDocumentResult>
  /** Export the active document as a `.kgz` container Blob (JSON + referenced image blobs). */
  exportDocument: () => Promise<Blob>
  /** Worker-backed generation snapshot: `busy` while any async element (handwriting, raster) still
   *  lacks settled geometry; `errors` lists elements whose generation failed (they never settle). */
  generationStatus: () => { busy: boolean; errors: string[] }
  /** Fit the whole bed into the viewport (same as the toolbar Zoom-to-fit). */
  fitView: () => void
}

declare global {
  interface Window {
    kurvengefahr: KurvengefahrApi
  }
}

export function installApi(): void {
  window.kurvengefahr = {
    importDocument: (data) => importDocumentContainer(data instanceof Blob ? data : new Blob([data])),
    exportDocument: exportActiveDocument,
    generationStatus: () => {
      const status = useGeneration.getState().status
      const errors: string[] = []
      let busy = false
      for (const el of useDoc.getState().elements) {
        if (!isAsyncType(el.type)) continue
        if (status[el.id]?.phase === 'error') errors.push(`${el.type} ${el.id}: ${status[el.id].message ?? 'failed'}`)
        else if (!getCached(el.id) || el.id in status) busy = true
      }
      return { busy, errors }
    },
    fitView: () => useViewport.getState().requestFit('all'),
  }
}
