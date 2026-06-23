// Async generation controller for worker-backed element types (handwriting).
//
// The main thread never runs the model. This module owns the generation Web Worker, fills the
// registry cache with finished geometry, and re-renders. Generation status (loading model /
// per-line progress / error) is published in a small zustand store the UI reads.
//
// Regeneration is **manual**: editing an element's params marks it *dirty* (cached geometry's hash
// no longer matches the params) but does NOT regenerate — the user clicks "Regenerate" (so editing
// several params at once isn't N wasted runs). The one exception is a brand-new element, which
// generates once automatically so it appears without a click.
//
// Rendering is **progressive**: the worker streams one line's geometry at a time; we append each to
// the cache and bump the document, so lines appear on the canvas as they're synthesized.
import { create } from 'zustand'
import type { DocElement, Geometry } from './types'
import { getCached, hashParams, markGenerated, isAsyncType } from '../elements/registry'
import { unflatten } from './wasm/serde'
import { useDoc } from '../store/document'

export type GenPhase = 'loading-model' | 'generating' | 'error'
export interface GenStatus {
  phase: GenPhase
  /** Lines completed / total (for `generating`). */
  done?: number
  total?: number
  message?: string
}

interface GenStore {
  /** Per-element generation status. Absent = idle (up-to-date or dirty). */
  status: Record<string, GenStatus>
  _set: (id: string, s: GenStatus) => void
  _clear: (id: string) => void
}

export const useGeneration = create<GenStore>((set) => ({
  status: {},
  _set: (id, s) => set((st) => ({ status: { ...st.status, [id]: s } })),
  _clear: (id) =>
    set((st) => {
      if (!(id in st.status)) return st
      const next = { ...st.status }
      delete next[id]
      return { status: next }
    }),
}))

const setStatus = (id: string, s: GenStatus) => useGeneration.getState()._set(id, s)
const clearStatus = (id: string) => useGeneration.getState()._clear(id)

/** True if the element's displayed geometry is stale relative to its current params (edited since
 *  the last generation). A never-generated element is not "dirty" — it auto-generates. */
export function isElementDirty(id: string, params: unknown): boolean {
  const cached = getCached(id)
  return !!cached && cached.hash !== hashParams(params)
}

// ---- worker plumbing ----

interface PartialMsg {
  type: 'partial'
  jobId: number
  elementId: string
  hash: string
  /** Words placed so far / total (for progress). */
  done: number
  total: number
  // Full placed geometry so far (replaces the cache each tick — the worker handles layout/alignment).
  xy: Float32Array
  pressure: Float32Array
  offsets: Uint32Array
  pen: Uint16Array
  reversible: Uint8Array
  group: Uint32Array
}
type WorkerOut =
  | { type: 'loading-model'; jobId: number; elementId: string }
  | PartialMsg
  | { type: 'done'; jobId: number; elementId: string }
  | { type: 'error'; jobId: number; elementId: string; message: string }

interface Job {
  jobId: number
  hash: string
}

let worker: Worker | null = null
let jobSeq = 0
const inflight = new Map<string, Job>()
/** Hashes that failed to generate — surfaced as an error until retry/params change. */
const failed = new Map<string, string>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./wasm/genWorker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<WorkerOut>) => handleMessage(e.data)
  }
  return worker
}

function handleMessage(msg: WorkerOut) {
  const job = inflight.get(msg.elementId)
  if (!job || job.jobId !== msg.jobId) return // superseded

  if (msg.type === 'loading-model') {
    setStatus(msg.elementId, { phase: 'loading-model' })
    return
  }
  if (msg.type === 'error') {
    inflight.delete(msg.elementId)
    failed.set(msg.elementId, job.hash)
    setStatus(msg.elementId, { phase: 'error', message: msg.message })
    return
  }
  if (msg.type === 'partial') {
    // The worker sends the full placed geometry so far (already laid out) — replace the cache and
    // re-render so words appear one at a time.
    const geom: Geometry = unflatten({
      xy: msg.xy,
      pressure: msg.pressure,
      offsets: msg.offsets,
      pen: msg.pen,
      reversible: msg.reversible,
      group: msg.group,
    })
    markGenerated(msg.elementId, job.hash, geom)
    setStatus(msg.elementId, { phase: 'generating', done: msg.done, total: msg.total })
    useDoc.getState().notifyGeometry()
    return
  }
  // done
  inflight.delete(msg.elementId)
  failed.delete(msg.elementId)
  clearStatus(msg.elementId)
  useDoc.getState().notifyGeometry()
}

function postGenerate(el: DocElement) {
  const hash = hashParams(el.params)
  const prev = inflight.get(el.id)
  if (prev) getWorker().postMessage({ type: 'cancel', jobId: prev.jobId })
  const jobId = ++jobSeq
  inflight.set(el.id, { jobId, hash })
  failed.delete(el.id)
  setStatus(el.id, { phase: 'generating', done: 0, total: 0 })
  getWorker().postMessage({ type: 'generate', jobId, elementId: el.id, hash, params: el.params })
}

function cleanup(id: string) {
  const cur = inflight.get(id)
  if (cur) {
    getWorker().postMessage({ type: 'cancel', jobId: cur.jobId })
    inflight.delete(id)
  }
  failed.delete(id)
  clearStatus(id)
}

/** Reconcile generation with the document: auto-generate brand-new async elements (so they appear
 *  without a click) and cancel work for removed ones. Param edits do NOT trigger generation — they
 *  leave the element dirty until the user regenerates. */
export function syncGeneration(elements: DocElement[]): void {
  const present = new Set<string>()
  for (const el of elements) {
    if (!isAsyncType(el.type)) continue
    present.add(el.id)
    // Never generated and not already running → initial generation.
    if (!getCached(el.id) && !inflight.has(el.id) && !failed.has(el.id)) {
      postGenerate(el)
    }
  }
  for (const id of inflight.keys()) {
    if (!present.has(id)) cleanup(id)
  }
}

/** Manually (re)generate one element with its current params. */
export function regenerate(id: string): void {
  const el = useDoc.getState().elements.find((e) => e.id === id)
  if (el) postGenerate(el)
}

/** Regenerate every dirty (or failed) async element. */
export function regenerateAll(): void {
  for (const el of useDoc.getState().elements) {
    if (isAsyncType(el.type) && (isElementDirty(el.id, el.params) || failed.has(el.id))) postGenerate(el)
  }
}
