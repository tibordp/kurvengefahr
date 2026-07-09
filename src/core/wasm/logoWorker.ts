// Logo program worker. Runs the Rust interpreter off the main thread: programs are user code and
// can legitimately take a while (bounded by the interpreter's deterministic limits), so the UI
// thread never blocks on a run. Owns its own WASM instance (like the vectorize worker) and speaks
// the same message protocol, so the generation controller drives all three workers identically:
// one `partial` (the full geometry) then `done`, or an `error`.
//
// Errors carry a structured `detail` (the interpreter's `{message, line, col, from, to}`) so the
// code editor can place a real diagnostic, while `message` stays the human-readable banner line.
import init, { logo_run } from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'
import { type LogoParams } from '../../elements/logo'
import type { FlatGeometry } from './serde'

// Typed worker `postMessage` (TS otherwise resolves the DOM Window overload that wants a string).
const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer)

interface GenerateMsg {
  type: 'generate'
  jobId: number
  elementId: string
  hash: string
  params: LogoParams
}
type InMsg = GenerateMsg | { type: 'cancel'; jobId: number }

/** The turtle's end pose: element-local page mm + compass heading (0 = up, clockwise). */
export interface LogoPose {
  x: number
  y: number
  heading: number
}

/** The interpreter's error shape (see crate/src/logo/mod.rs `error_json`). */
export interface LogoRunError {
  message: string
  /** 1-based, for the human-readable banner. */
  line: number
  col: number
  /** UTF-16 code-unit offsets into the source, for editor diagnostics. */
  from: number
  to: number
}

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

async function runJob(job: GenerateMsg) {
  const { jobId, elementId, hash, params } = job
  try {
    await ready
    if (cancelled.has(jobId)) return

    const res = logo_run(JSON.stringify(params))
    // Read the flat buffers out (getters copy into JS memory) before freeing the Rust struct.
    const flat: FlatGeometry = {
      xy: res.xy,
      pressure: res.pressure,
      offsets: res.offsets,
      pen: res.pen,
      reversible: res.reversible,
      group: res.group,
    }
    // The turtle's end pose (element-local page mm + compass heading) — the editor draws a
    // turtle marker there. Travels as the generic `meta` sidecar of the partial message.
    const meta: LogoPose = { x: res.x, y: res.y, heading: res.heading }
    res.free()
    if (cancelled.has(jobId)) return

    post(
      { type: 'partial', jobId, elementId, hash, done: 1, total: 1, meta, ...flat },
      [flat.xy.buffer, flat.pressure.buffer, flat.offsets.buffer, flat.pen.buffer, flat.reversible.buffer, flat.group.buffer],
    )
    post({ type: 'done', jobId, elementId })
  } catch (err) {
    // The interpreter throws its error as a JSON string; anything else (bad WASM load, …) is a
    // plain message with no position detail.
    let message = String((err as Error)?.message ?? err)
    let detail: LogoRunError | undefined
    try {
      const parsed = JSON.parse(message) as LogoRunError
      if (typeof parsed?.message === 'string') {
        detail = parsed
        message = parsed.line > 0 ? `Line ${parsed.line}: ${parsed.message}` : parsed.message
      }
    } catch {
      // not JSON — keep the raw message
    }
    post({ type: 'error', jobId, elementId, message, detail })
  } finally {
    cancelled.delete(jobId)
  }
}
