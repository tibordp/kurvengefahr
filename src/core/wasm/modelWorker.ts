// 3D-model wireframe worker. Turns an uploaded STL into feature-edge strokes off the main
// thread: loading the blob from IndexedDB is async, and parsing + z-buffering a large mesh is
// too heavy for the UI thread. Owns its *own* WASM instance and speaks the same message protocol
// as the other generation workers: one `partial` (the full geometry) then `done`, or an `error`.
// Every knob regenerates live, so the model bytes are cached (keyed by modelId, which is
// immutable) — a re-render on an orbit or option edit re-runs only the Rust, not the IDB fetch.
import init, { wireframe } from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'
import { getImageBlob } from '../../store/images'
import { type ModelParams } from '../../elements/model'
import type { FlatGeometry } from './serde'

// Typed worker `postMessage` (TS otherwise resolves the DOM Window overload that wants a string).
const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer)

interface GenerateMsg {
  type: 'generate'
  jobId: number
  elementId: string
  hash: string
  params: ModelParams
}
type InMsg = GenerateMsg | { type: 'cancel'; jobId: number }

const ready = init({ module_or_path: wasmUrl })
const cancelled = new Set<number>()
const queue: GenerateMsg[] = []
let pumping = false

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId)
    return
  }
  queue.push(msg)
  void pump()
}

async function pump() {
  if (pumping) return
  pumping = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      if (cancelled.has(job.jobId)) {
        cancelled.delete(job.jobId)
        continue
      }
      await runJob(job)
    }
  } finally {
    pumping = false
  }
}

// One-entry byte cache: editing params regenerates from the *same* model (modelId is immutable).
let byteCache: { modelId: string; bytes: Uint8Array } | null = null

async function getBytes(modelId: string): Promise<Uint8Array> {
  if (byteCache?.modelId === modelId) return byteCache.bytes
  const blob = await getImageBlob(modelId)
  if (!blob) throw new Error('model not found')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  byteCache = { modelId, bytes }
  return bytes
}

async function runJob(job: GenerateMsg) {
  const { jobId, elementId, hash, params } = job
  const aborted = () => cancelled.has(jobId)
  try {
    await ready
    if (aborted()) return

    const bytes = await getBytes(params.modelId)
    if (aborted()) return

    const res = wireframe(bytes, JSON.stringify(params))
    // Read the flat buffers out (getters copy into JS memory) before freeing the Rust struct.
    const flat: FlatGeometry = {
      xy: res.xy,
      pressure: res.pressure,
      offsets: res.offsets,
      pen: res.pen,
      reversible: res.reversible,
      group: res.group,
    }
    res.free()
    if (aborted()) return

    post(
      { type: 'partial', jobId, elementId, hash, done: 1, total: 1, ...flat },
      [flat.xy.buffer, flat.pressure.buffer, flat.offsets.buffer, flat.pen.buffer, flat.reversible.buffer, flat.group.buffer],
    )
    post({ type: 'done', jobId, elementId })
  } catch (err) {
    post({ type: 'error', jobId, elementId, message: String((err as Error)?.message ?? err) })
  } finally {
    cancelled.delete(jobId)
  }
}
