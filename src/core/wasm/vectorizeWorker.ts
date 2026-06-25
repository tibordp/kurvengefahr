// Image vectorization worker. Traces an uploaded raster into pen strokes off the main thread:
// loading the blob from IndexedDB and decoding the image are async, and tracing a few-MP bitmap is
// too heavy for the UI thread. Owns its *own* WASM instance (separate from the handwriting worker's,
// which carries the ~7 MB model). Speaks the same message protocol as the handwriting worker so the
// generation controller drives both identically: one `partial` (the full geometry) then `done`, or
// an `error`. No model, no streaming — a single one-shot trace.
import init, { vectorize_image } from '@wasm/kg_toolpath.js'
import wasmUrl from '@wasm/kg_toolpath_bg.wasm?url'
import { getImageBlob } from '../../store/images'
import { METHOD_CODE, type RasterParams } from '../../elements/raster'

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

/** Decode an image blob to raw RGBA bytes + dimensions via an OffscreenCanvas. */
async function decodeRgba(blob: Blob): Promise<{ rgba: Uint8Array; width: number; height: number }> {
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

async function runJob(job: GenerateMsg) {
  const { jobId, elementId, hash, params } = job
  const aborted = () => cancelled.has(jobId)
  try {
    await ready
    if (aborted()) return

    const blob = await getImageBlob(params.imageId)
    if (aborted()) return
    if (!blob) throw new Error('image not found')

    const { rgba, width, height } = await decodeRgba(blob)
    if (aborted()) return

    const res = vectorize_image(
      rgba,
      width,
      height,
      params.targetWidthMm,
      params.targetHeightMm,
      METHOD_CODE[params.method] ?? 0,
      Math.round(params.threshold),
      params.invert,
      params.simplifyTol,
      params.minArea,
    )
    // Read the flat buffers out (getters copy into JS memory) before freeing the Rust struct.
    const xy = res.xy
    const pressure = res.pressure
    const offsets = res.offsets
    const pen = res.pen
    const reversible = res.reversible
    const group = res.group
    res.free()

    if (aborted()) return
    post(
      { type: 'partial', jobId, elementId, hash, done: 1, total: 1, xy, pressure, offsets, pen, reversible, group },
      [xy.buffer, pressure.buffer, offsets.buffer, pen.buffer, reversible.buffer, group.buffer],
    )
    post({ type: 'done', jobId, elementId })
  } catch (err) {
    post({ type: 'error', jobId, elementId, message: String((err as Error)?.message ?? err) })
  } finally {
    cancelled.delete(jobId)
  }
}
