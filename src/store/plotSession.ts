// The live plot session (AxiDraw or GRBL): one streaming run at a time, from plan through the
// serial streaming loop to done/cancelled/error. Owns the session lifecycle and progress; the
// canvas shows live position through the preview overlay in `driven` mode (the session writes
// the playhead), and PlotHUD renders progress + pause/stop from here.
//
// Progress is kind-neutral: `done`/`total` are ms on an AxiDraw (dead-reckoned segment durations
// — the EBB reports nothing back) and mm of toolpath on GRBL (projected from the machine's own
// `?` position reports). The HUD only needs the fraction plus the precomputed `etaMs`.
import { create } from 'zustand'
import { runPipeline } from '../core/pipeline'
import { buildToolpath } from '../core/preview/toolpath'
import { penParkInPage } from '../core/pipeline/toMachine'
import { STEPS_PER_MM } from '../core/pipeline/planTypes'
import { validateProfile } from '../core/profileValidation'
import { PlotRun } from '../output/ebb/session'
import { GrblRun } from '../output/grbl/session'
import type { PlotDriver, PromptKind } from '../output/session'
import { currentEbb, currentGrbl } from './serial'
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
  /** Kind-neutral progress pair — only the fraction is meaningful to the UI. */
  total: number
  done: number
  /** Estimated remaining time, or null while there's no estimate yet. */
  etaMs: number | null
  currentPen: number
  prompt: PlotPrompt | null
  start: () => Promise<void>
  pause: () => void
  resume: () => void
  cancel: () => void
  /** Answer the open operator prompt: continue (true) or stop the plot (false). */
  confirmPrompt: (go: boolean) => void
}

let run: PlotDriver | null = null
let promptResolve: ((go: boolean) => void) | null = null

const blockUnload = (e: BeforeUnloadEvent) => e.preventDefault()

/** Smooth AxiDraw playhead: acks arrive one segment at a time (and, pipelined, in bursts), so
 *  writing `dist` per ack makes the turtle jump. Instead a rAF loop advances a wall clock through
 *  the tape, clamped to the acked frontier (`done` ms), and lerps `dist` within the segment. */
function startEbbPlayhead(plan: { durationMs: Float32Array; dist: Float32Array; length: number }): () => void {
  let raf = 0
  let playMs = 0
  let idx = 0
  let cumStart = 0 // cumulative ms at the start of segment `idx`
  let last = performance.now()
  const tick = (now: number) => {
    const { phase, done } = usePlotSession.getState()
    if (phase === 'plotting') playMs = Math.min(playMs + (now - last), done)
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

/** Smooth GRBL playhead: the machine reports its own position ~5×/s; the turtle exponentially
 *  chases the latest report, so it moves continuously and never overshoots the pen. */
function startGrblPlayhead(): { onDist: (mm: number) => void; stop: () => void } {
  const TAU_MS = 150
  let target = 0
  let current = 0
  let raf = 0
  let last = performance.now()
  const tick = (now: number) => {
    const dt = now - last
    last = now
    current += (target - current) * Math.min(1, dt / TAU_MS)
    usePreview.getState().setDist(current)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return { onDist: (mm) => (target = Math.max(target, mm)), stop: () => cancelAnimationFrame(raf) }
}

export const usePlotSession = create<PlotSessionStore>((set, get) => ({
  phase: 'idle',
  total: 0,
  done: 0,
  etaMs: null,
  currentPen: 0,
  prompt: null,

  start: async () => {
    if (get().phase !== 'idle') return
    const { elements, profile, fiducial } = useDoc.getState()
    const ebb = currentEbb()
    const grbl = currentGrbl()
    const connected = profile.kind === 'axidraw' ? ebb : profile.kind === 'grbl' ? grbl : null
    if (!connected || elements.length === 0) return
    if (validateProfile(profile).length) {
      toast.error('Fix the machine profile before plotting.')
      return
    }
    set({ phase: 'planning', done: 0, total: 0, etaMs: null, prompt: null })
    let stopPlayhead: (() => void) | null = null
    try {
      const out = await runPipeline(elements, profile, fiducial)
      const empty =
        out.kind === 'gcode' || (out.kind === 'axidraw' ? out.plan.length === 0 : out.tape.length === 0)
      if (empty) {
        set({ phase: 'idle' })
        if (out.kind !== 'gcode') toast.info('Nothing to plot — the page is empty.')
        return
      }

      // Live overlay: read-only canvas + turtle; the playhead follows the machine.
      const park = penParkInPage(profile)
      useTools.getState().setTool('select')
      usePreview.getState().enterDriven(buildToolpath(out.optimized, park, fiducial))
      window.addEventListener('beforeunload', blockUnload)

      const sessionHooks = {
        onPaused: () => set({ phase: 'paused' }),
        onResumed: () => set({ phase: 'plotting' }),
        prompt: (kind: PromptKind, pen: number) =>
          new Promise<boolean>((resolve) => {
            promptResolve = resolve
            set({ phase: 'waiting', prompt: { kind, pen }, currentPen: pen })
          }),
      }

      if (out.kind === 'axidraw' && profile.kind === 'axidraw' && ebb) {
        const { plan } = out
        set({ total: plan.totalDurationMs, currentPen: plan.pen[0] ?? 0, phase: 'plotting' })
        stopPlayhead = startEbbPlayhead(plan)
        let acked = 0
        run = new PlotRun(plan, ebb, profile.servo, { travelSpeed: profile.motion.travelSpeed, stepsPerMm: STEPS_PER_MM }, {
          ...sessionHooks,
          onProgress: (i) => {
            acked += plan.durationMs[i]
            set({ done: acked, etaMs: plan.totalDurationMs - acked, currentPen: plan.pen[i] })
          },
        })
      } else if (out.kind === 'grbl' && profile.kind === 'grbl' && grbl) {
        const { tape } = out
        set({ total: tape.totalDist, currentPen: tape.pen[0] ?? 0, phase: 'plotting' })
        const playhead = startGrblPlayhead()
        stopPlayhead = playhead.stop
        // ETA from the observed plot rate (EMA over position reports) — pause gaps are skipped,
        // so holding for a pen swap doesn't poison the estimate.
        let lastT = 0
        let lastD = 0
        let rate = 0 // mm per ms
        run = new GrblRun(tape, grbl, profile, {
          ...sessionHooks,
          onProgress: (i) => set({ currentPen: tape.pen[i] }),
          onDist: (mm) => {
            const now = performance.now()
            const dt = now - lastT
            if (lastT && dt > 0 && dt < 1000 && mm > lastD) {
              const r = (mm - lastD) / dt
              rate = rate ? rate * 0.8 + r * 0.2 : r
            }
            lastT = now
            lastD = mm
            playhead.onDist(mm)
            set({ done: mm, etaMs: rate > 0 ? (tape.totalDist - mm) / rate : null })
          },
        })
      } else {
        set({ phase: 'idle' })
        return
      }

      const result = await run.run()
      if (result === 'done') toast.success('Plot finished.')
      else toast.info('Plot stopped — the pen returned home.')
    } catch (e) {
      const recovery =
        profile.kind === 'axidraw'
          ? 'Re-park the carriage at the home corner before plotting again.'
          : 'Check the machine and re-zero it at the page origin before plotting again.'
      toast.error(`Plot failed: ${e instanceof Error ? e.message : String(e)}. ${recovery}`)
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
