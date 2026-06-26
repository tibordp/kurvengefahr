// Image vectorization worker. Traces an uploaded raster into pen strokes off the main thread:
// loading the blob from IndexedDB and decoding the image are async, and tracing a few-MP bitmap is
// too heavy for the UI thread. Owns its *own* WASM instance (separate from the handwriting worker's,
// which carries the ~7 MB model). Speaks the same message protocol as the handwriting worker so the
// generation controller drives both identically: one `partial` (the full geometry) then `done`, or
// an `error`. Every method traces live as params change, so the decoded image is cached (keyed by
// imageId, which is immutable) — a re-trace on a slider edit re-runs only the Rust, not the decode.
import init, { vectorize_image } from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'
import { getImageBlob } from '../../store/images'
import { type RasterParams } from '../../elements/raster'
import type { FlatGeometry } from './serde'

// Typed worker `postMessage` (TS otherwise resolves the DOM Window overload that wants a string).
const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer)

interface GenerateMsg {
  type: 'generate'
  jobId: number
  elementId: string
  hash: string
  params: RasterParams
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

interface Decoded {
  rgba: Uint8Array
  width: number
  height: number
}

// One-entry decode cache: editing params re-traces the *same* image, so decoding it once and reusing
// the bytes makes a live slider drag re-run only the Rust. Keyed by imageId (immutable per image).
let decodeCache: { imageId: string; data: Decoded } | null = null

/** Decode an image blob to raw RGBA bytes + dimensions via an OffscreenCanvas. */
async function decodeRgba(blob: Blob): Promise<Decoded> {
  const bitmap = await createImageBitmap(blob)
  try {
    const { width, height } = bitmap
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, width, height).data
    return { rgba: new Uint8Array(data.buffer), width, height }
  } finally {
    bitmap.close()
  }
}

/** Decoded RGBA for an image, from the cache when the id matches (params-only edits hit this). */
async function getDecoded(imageId: string): Promise<Decoded> {
  if (decodeCache?.imageId === imageId) return decodeCache.data
  const blob = await getImageBlob(imageId)
  if (!blob) throw new Error('image not found')
  const data = await decodeRgba(blob)
  decodeCache = { imageId, data }
  return data
}

async function runJob(job: GenerateMsg) {
  const { jobId, elementId, hash, params } = job
  const aborted = () => cancelled.has(jobId)
  try {
    await ready
    if (aborted()) return

    const { rgba, width, height } = await getDecoded(params.imageId)
    if (aborted()) return

    const res = vectorize_image(rgba, width, height, JSON.stringify(params))
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
