// The public browser API: a small, stable surface on `window.kurvengefahr` for userscripts,
// browser extensions, and headless automation (docs/screenshot.mjs). Installed unconditionally at
// boot (main.tsx). Keep it small and additive — every published member is a compatibility promise.
// Everything returned is detached plain data (never live store references), and inputs are coerced
// through the same sanitizers imports use, so garbage in degrades to defaults rather than
// corrupting the document.
import {
  importDocumentContainer,
  exportActiveDocument,
  activeDocumentFile,
  type ImportDocumentResult,
} from './output/documentContainer'
import { buildSvgBlob, buildPngBlob } from './output/exportVector'
import { useDoc } from './store/document'
import { useGeneration } from './core/generation'
import { getCached, isAsyncType, isKnownType, sanitizeParams } from './elements/registry'
import { useViewport } from './store/viewport'
import { buildPlottableGeometry, runPipeline } from './core/pipeline'
import { emitGrbl } from './core/pipeline/emitGrbl'
import { validateProfile } from './core/profileValidation'

export interface ApiElementMeta {
  id: string
  type: string
  name?: string
  pen: number
  parent?: string
  hidden?: boolean
}

export interface ApiStroke {
  pen: number
  points: { x: number; y: number; pressure?: number }[]
}

export interface KurvengefahrApi {
  /** Import a `.kgz` container as a new document (binds this tab to it). Never throws. */
  importDocument: (data: ArrayBuffer | Uint8Array<ArrayBuffer> | Blob) => Promise<ImportDocumentResult>
  /** Export the active document as a `.kgz` container Blob (JSON + referenced image blobs). */
  exportDocument: () => Promise<Blob>
  /** The active document as plain JSON — the same envelope as `document.json` inside a `.kgz`
   *  (without image blobs; raster elements reference them by id). */
  getDocument: () => unknown
  /** Light metadata for every element, in z-order. */
  listElements: () => ApiElementMeta[]
  /** Add an element of a registered type at a page-space position and select it. Params are coerced
   *  exactly like an imported document's (unknown fields dropped, missing ones defaulted), so
   *  partial params are fine. Returns the new element's id, or null for an unknown type. */
  addElement: (
    type: string,
    params?: unknown,
    at?: { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number },
  ) => string | null
  /** Replace the selection (unknown ids are ignored). */
  selectElements: (ids: string[]) => void
  /** The machine-neutral strokes that would plot — generated, effected, placed in page mm, and
   *  clipped to the reachable area. Exactly what Generate and the preview agree on. */
  getPlottableGeometry: () => ApiStroke[]
  /** The full G-code for the document. Null on an empty document or a non-G-code machine (an
   *  AxiDraw plots live over serial); throws when the machine profile is invalid. */
  buildGcode: () => Promise<string | null>
  /** Render what would plot as an SVG Blob (one layer per pen) — the same output as Export. */
  renderSvg: () => Blob
  /** Render what would plot as a transparent PNG Blob at `pxPerMm` (defaulted to a crisp,
   *  bounded size). Null only if canvas encoding fails. */
  renderPng: (pxPerMm?: number) => Promise<Blob | null>
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
    getDocument: () => structuredClone(activeDocumentFile()),
    listElements: () =>
      useDoc.getState().elements.map((el) => ({
        id: el.id,
        type: el.type,
        ...(el.name !== undefined ? { name: el.name } : {}),
        pen: el.pen,
        ...(el.parent !== undefined ? { parent: el.parent } : {}),
        ...(el.hidden ? { hidden: true } : {}),
      })),
    addElement: (type, params, at) => {
      if (!isKnownType(type)) return null
      return useDoc.getState().addElement(type, sanitizeParams(type, params), at)
    },
    selectElements: (ids) => {
      const known = new Set(useDoc.getState().elements.map((e) => e.id))
      useDoc.getState().selectMany(ids.filter((id) => known.has(id)))
    },
    getPlottableGeometry: () => {
      const { elements, profile } = useDoc.getState()
      return buildPlottableGeometry(elements, profile).map((s) => ({
        pen: s.pen,
        points: s.points.map((p) => ({ x: p.x, y: p.y, ...(p.pressure !== undefined ? { pressure: p.pressure } : {}) })),
      }))
    },
    buildGcode: async () => {
      const { elements, profile, fiducial } = useDoc.getState()
      if (elements.length === 0 || profile.kind === 'axidraw') return null
      const issues = validateProfile(profile)
      if (issues.length) throw new Error(`machine profile invalid: ${issues.join('; ')}`)
      const out = await runPipeline(elements, profile, fiducial)
      if (out.kind === 'gcode') return out.gcode
      if (out.kind === 'grbl' && profile.kind === 'grbl') return emitGrbl(out.tape, profile)
      return null
    },
    renderSvg: buildSvgBlob,
    renderPng: buildPngBlob,
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
