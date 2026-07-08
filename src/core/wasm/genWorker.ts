// Handwriting generation worker. Runs the Graves RNN-MDN off the main thread so the heavy sampling
// never locks the UI. Owns its *own* WASM instance and the ~7 MB model blob — the main thread never
// loads the model (it only needs clip/optimize/substitution).
//
// We generate **one word at a time** (each primed on the bundled golden sample, so the whole element
// shares one consistent hand) and **typeset manually**: words are laid left→right, wrapped by width,
// with line baselines and alignment computed here. After each word we post the full placed geometry
// so the canvas fills in word by word. Between words we yield so a superseded job can abandon.
import init, {
  init_model,
  model_ready,
  clean_text,
  generate_word,
} from '@wasm/kg_core.js'
import wasmUrl from '@wasm/kg_core_bg.wasm?url'
import { flatten, unflatten } from './serde'
import { lineShift, justifyOffsets } from './layoutMath'
import type { Geometry } from '../types'
import type { HandwritingParams } from '../../elements/handwriting'

/** Fraction of an em reserved above the first baseline (ascenders). */
const TOP_PAD_EM = 0.9

// Typed worker `postMessage` (TS otherwise resolves the DOM Window overload that wants a string).
const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void }).postMessage(msg, transfer)

const MODEL_URL = `${import.meta.env.BASE_URL}models/kg_model.f16.bin`

interface GenerateMsg {
  type: 'generate'
  jobId: number
  elementId: string
  hash: string
  params: HandwritingParams
}
type InMsg = GenerateMsg | { type: 'cancel'; jobId: number }

const ready = init({ module_or_path: wasmUrl })
let modelLoad: Promise<void> | null = null
const cancelled = new Set<number>()
const queue: GenerateMsg[] = []
let pumping = false

function ensureModel(): Promise<void> {
  if (!modelLoad) {
    modelLoad = (async () => {
      const res = await fetch(MODEL_URL)
      if (!res.ok) throw new Error(`failed to fetch handwriting model (${res.status})`)
      init_model(new Uint8Array(await res.arrayBuffer()))
    })().catch((err) => {
      modelLoad = null // allow retry on a later job
      throw err
    })
  }
  return modelLoad
}

/** Yield to the event loop so queued `cancel`/`generate` messages are delivered between words. */
const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0))

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

/** Translate every point of a word's geometry to its place on the page. */
function translate(geom: Geometry, dx: number, dy: number): Geometry {
  for (const s of geom) for (const p of s.points) {
    p.x += dx
    p.y += dy
  }
  return geom
}

async function runJob(job: GenerateMsg) {
  const { jobId, elementId, hash, params } = job
  const aborted = () => cancelled.has(jobId)
  try {
    await ready
    if (aborted()) return
    if (!model_ready()) {
      post({ type: 'loading-model', jobId, elementId })
      await ensureModel()
      if (aborted()) return
    }

    const { layout, style } = params
    const fs = layout.fontSizeMm
    const space = layout.wordSpacingEm * fs
    const advance = layout.lineHeightEm * fs
    const paragraphGap = layout.paragraphSpacingEm * fs

    // Split the substituted text into paragraphs (hard breaks) of words.
    const paragraphs = clean_text(params.text).split('\n').map((p) => p.split(/\s+/).filter(Boolean))
    const total = paragraphs.reduce((n, w) => n + w.length, 0)

    const placed: Geometry = [] // finalized (aligned/justified) lines
    let line: { geom: Geometry; width: number }[] = [] // current line's words, at running penX
    let penX = 0
    let baselineY = TOP_PAD_EM * fs
    let lineWidth = 0
    let done = 0
    let wordSeq = 0

    /** Finalize the current line. Justify stretches gaps on soft (wrap-broken) lines only; hard
     *  breaks (paragraph end) stay ragged, like the last line of any justified paragraph. */
    const flushLine = (soft: boolean) => {
      if (layout.align === 'justify') {
        const shifts = justifyOffsets(line.length, layout.maxWidthMm, lineWidth, soft)
        for (let i = 0; i < line.length; i++) if (shifts[i] !== 0) translate(line[i].geom, shifts[i], 0)
      } else {
        const dx = lineShift(layout.align, layout.maxWidthMm, lineWidth)
        if (dx !== 0) for (const w of line) translate(w.geom, dx, 0)
      }
      for (const w of line) for (const s of w.geom) placed.push(s)
      line = []
      penX = 0
      lineWidth = 0
    }
    const postPartial = () => {
      // Show the current line at its in-progress alignment without baking it in yet (justify
      // renders ragged-left until the line is complete — gaps only stretch at flush).
      const dx = layout.align === 'justify' ? 0 : lineShift(layout.align, layout.maxWidthMm, lineWidth)
      const current = line.flatMap((w) => w.geom)
      const display = dx !== 0 ? current.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx })) })) : current
      const flat = flatten(placed.concat(display))
      post({ type: 'partial', jobId, elementId, hash, done, total, ...flat }, [
        flat.xy.buffer, flat.pressure.buffer, flat.offsets.buffer, flat.pen.buffer, flat.reversible.buffer, flat.group.buffer,
      ])
    }

    for (const words of paragraphs) {
      if (words.length === 0) {
        // Blank line: end the current line and leave a vertical gap.
        flushLine(false)
        baselineY += advance + paragraphGap
        continue
      }
      for (const word of words) {
        await yieldToLoop()
        if (aborted()) return
        // Per-word seed: deterministic but varied so repeated words don't look stamped.
        const seed = (style.seed >>> 0) + (wordSeq++ >>> 0) * 0x9e3779b1
        const res = generate_word(word, fs, layout.slantDeg, seed >>> 0, style.bias)
        const width = res.width
        const wordGeom = unflatten({
          xy: res.xy, pressure: res.pressure, offsets: res.offsets,
          pen: res.pen, reversible: res.reversible, group: res.group,
        })
        res.free()

        // Wrap if this word would overflow the current (non-empty) line.
        if (penX > 0 && penX + width > layout.maxWidthMm) {
          flushLine(true)
          baselineY += advance
        }
        translate(wordGeom, penX, baselineY)
        line.push({ geom: wordGeom, width })
        penX += width + space
        lineWidth = penX - space
        done++
        postPartial()
      }
      // Paragraph boundary → hard line break.
      flushLine(false)
      baselineY += advance + paragraphGap
    }

    if (aborted()) return
    post({ type: 'done', jobId, elementId })
  } catch (err) {
    post({ type: 'error', jobId, elementId, message: String((err as Error)?.message ?? err) })
  } finally {
    cancelled.delete(jobId)
  }
}
