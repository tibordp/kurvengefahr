// The live AxiDraw plot session: one streaming run at a time, from Plan through the serial
// streaming loop to done/cancelled/error. Owns the session lifecycle and progress; the canvas
// shows live position through the preview overlay in `driven` mode (the session writes the
// playhead), and PlotHUD renders progress + pause/stop from here.
import { create } from 'zustand'
import { runPipeline } from '../core/pipeline'
import { buildToolpath } from '../core/preview/toolpath'
import { penParkInPage } from '../core/pipeline/toMachine'
import { STEPS_PER_MM } from '../core/pipeline/planTypes'
import { validateProfile } from '../core/profileValidation'
import { PlotRun, type PromptKind } from '../output/ebb/session'
import { currentEbb } from './serial'
import { useDoc } from './document'
import { usePreview } from './preview'
import { useTools } from './tools'
import { toast } from './toast'

export type PlotPhase =
  | 'idle'
  | 'planning'
  | 'plotting'
  | 'pausing' // pause requested, waiting for the next safe boundary
  | 'paused'
  | 'waiting' // operator prompt open (fiducial / pen swap)

export interface PlotPrompt {
  kind: PromptKind
  pen: number
}

interface PlotSessionStore {
  phase: PlotPhase
  totalMs: number
  /** Acknowledged plot time so far (dead-reckoned from segment durations). */
  doneMs: number
  currentPen: number
  prompt: PlotPrompt | null
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  cancel: () => void
  /** Answer the open operator prompt: continue (true) or stop the plot (false). */
  confirmPrompt: (go: boolean) => void
}

let run: PlotRun | null = null
let promptResolve: ((go: boolean) => void) | null = null

const blockUnload = (e: BeforeUnloadEvent) => e.preventDefault()

/** Smooth playhead: acks arrive one segment at a time (and, pipelined, in bursts), so writing
 *  `dist` per ack makes the turtle jump. Instead a rAF loop advances a wall clock through the
 *  tape, clamped to the acked frontier (`doneMs`), and lerps `dist` within the current segment. */
function startPlayhead(plan: { durationMs: Float32Array; dist: Float32Array; length: number }): () => void {
  let raf = 0
  let playMs = 0
  let idx = 0
  let cumStart = 0 // cumulative ms at the start of segment `idx`
  let last = performance.now()
  const tick = (now: number) => {
    const { phase, doneMs } = usePlotSession.getState()
    if (phase === 'plotting') playMs = Math.min(playMs + (now - last), doneMs)
    last = now
    while (idx < plan.length && playMs > cumStart + plan.durationMs[idx]) {
      cumStart += plan.durationMs[idx]
      idx++
    }
    if (idx < plan.length) {
      const prev = idx > 0 ? plan.dist[idx - 1] : 0
      const dur = plan.durationMs[idx]
      const t = dur > 0 ? Math.min(1, (playMs - cumStart) / dur) : 1
      usePreview.getState().setDist(prev + (plan.dist[idx] - prev) * t)
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}

export const usePlotSession = create<PlotSessionStore>((set, get) => ({
  phase: 'idle',
  totalMs: 0,
  doneMs: 0,
  currentPen: 0,
  prompt: null,

  start: async () => {
    if (get().phase !== 'idle') return
    const { elements, profile, fiducial } = useDoc.getState()
    const ebb = currentEbb()
    if (profile.kind !== 'axidraw' || !ebb || elements.length === 0) return
    if (validateProfile(profile).length) {
      toast.error('Fix the machine profile before plotting.')
      return
    }
    set({ phase: 'planning', doneMs: 0, totalMs: 0, prompt: null })
    let stopPlayhead: (() => void) | null = null
    try {
      const out = await runPipeline(elements, profile, fiducial)
      if (out.kind !== 'axidraw' || out.plan.length === 0) {
        set({ phase: 'idle' })
        if (out.kind === 'axidraw') toast.info('Nothing to plot — the page is empty.')
        return
      }
      const { plan } = out
      // Live overlay: read-only canvas + turtle; the playhead rAF loop follows the machine acks.
      const park = penParkInPage(profile)
      useTools.getState().setTool('select')
      usePreview.getState().enterDriven(buildToolpath(out.optimized, park, fiducial))
      set({ totalMs: plan.totalDurationMs, currentPen: plan.pen[0] ?? 0, phase: 'plotting' })
      window.addEventListener('beforeunload', blockUnload)
      stopPlayhead = startPlayhead(plan)

      let acked = 0
      run = new PlotRun(
        plan,
        ebb,
        profile.servo,
        { travelSpeed: profile.motion.travelSpeed, stepsPerMm: STEPS_PER_MM },
        {
          onProgress: (i) => {
            acked += plan.durationMs[i]
            set({ doneMs: acked, currentPen: plan.pen[i] })
          },
          onPaused: () => set({ phase: 'paused' }),
          onResumed: () => set({ phase: 'plotting' }),
          prompt: (kind, pen) =>
            new Promise<boolean>((resolve) => {
              promptResolve = resolve
              set({ phase: 'waiting', prompt: { kind, pen }, currentPen: pen })
            }),
        },
      )
      const result = await run.run()
      if (result === 'done') toast.success('Plot finished.')
      else toast.info('Plot stopped — the pen returned home.')
    } catch (e) {
      toast.error(
        `Plot failed: ${e instanceof Error ? e.message : String(e)}. ` +
          'Re-park the carriage at the home corner before plotting again.',
      )
    } finally {
      stopPlayhead?.()
      window.removeEventListener('beforeunload', blockUnload)
      run = null
      promptResolve = null
      usePreview.getState().exit()
      set({ phase: 'idle', prompt: null })
    }
  },

  pause: () => {
    if (get().phase !== 'plotting') return
    run?.requestPause()
    set({ phase: 'pausing' })
  },

  resume: () => {
    if (get().phase !== 'paused') return
    run?.requestResume()
  },

  cancel: () => {
    // Works from any live state: streaming, paused, or mid-prompt (the prompt resolves as stop).
    if (promptResolve) {
      const r = promptResolve
      promptResolve = null
      set({ prompt: null })
      r(false)
      return
    }
    run?.requestCancel()
  },

  confirmPrompt: (go) => {
    const r = promptResolve
    if (!r) return
    promptResolve = null
    set({ prompt: null, phase: go ? 'plotting' : get().phase })
    r(go)
  },
}))
