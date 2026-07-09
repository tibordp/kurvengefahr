import { describe, expect, it, vi } from 'vitest'
import type { GrblProfile } from '../../core/types'
import { GRBL_PLOTTER } from '../../store/profiles'
import { planGrblTape } from '../../core/pipeline/grblTape'
import type { Geometry } from '../../core/types'
import { Grbl } from './protocol'
import { MockGrbl, type MockGrblOptions } from './mock'
import { GrblRun, type GrblSessionHooks } from './session'

function profile(over: Partial<GrblProfile> = {}): GrblProfile {
  return { ...structuredClone(GRBL_PLOTTER), origin: 'top-left', ...over }
}

const stroke = (pts: [number, number][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y]) => ({ x, y })),
  pen,
  reversible: true,
})

/** Travel 10mm, draw 10mm, walk home — the simplest real tape. */
const SIMPLE: Geometry = [stroke([[10, 0], [20, 0]])]

function hooks(overrides: Partial<GrblSessionHooks> = {}) {
  const progressed: number[] = []
  const dists: number[] = []
  const events: string[] = []
  const h: GrblSessionHooks = {
    onProgress: (i) => progressed.push(i),
    onDist: (mm) => dists.push(mm),
    onPaused: () => events.push('paused'),
    onResumed: () => events.push('resumed'),
    prompt: async () => true,
    ...overrides,
  }
  return { h, progressed, dists, events }
}

function makeRun(geom: Geometry, p: GrblProfile, mockOpts: MockGrblOptions = {}, hookOverrides: Partial<GrblSessionHooks> = {}) {
  const t = new MockGrbl(mockOpts)
  const run = new GrblRun(planGrblTape(geom, p), new Grbl(t), p, hooks(hookOverrides).h)
  return { t, run }
}

describe('GrblRun', () => {
  it('streams a servo job: unlock-free init, work zero, pen moves, walk home, M5', async () => {
    const p = profile()
    const t = new MockGrbl()
    const { h, progressed } = hooks()
    const run = new GrblRun(planGrblTape(SIMPLE, p), new Grbl(t), p, h)
    expect(await run.run()).toBe('done')
    expect(t.sent.slice(0, 4)).toEqual(['G21', 'G90', 'G54', 'G10 L20 P1 X0 Y0 Z0'])
    expect(t.sent).not.toContain('$H')
    expect(t.sent).not.toContain('$X') // machine wasn't alarmed
    expect(t.sent).toContain('M3 S750') // pen up
    expect(t.sent).toContain('M3 S250') // pen down
    expect(t.sent).toContain('G0 X10.000 Y0.000')
    expect(t.sent).toContain('G1 X20.000 Y0.000 F1500.000')
    expect(t.sent).toContain('G0 X0.000 Y0.000') // walk home
    expect(t.sent.at(-1)).toBe('M5')
    // Every tape segment reported, in order.
    expect(progressed).toEqual([...progressed].sort((a, b) => a - b))
    expect(progressed.at(-1)).toBe(planGrblTape(SIMPLE, p).length - 1)
  })

  it('homes (once) when the profile says so, and Z-mode uses Z moves', async () => {
    const p = profile({ homing: true, pen: { mode: 'z', up: 5, down: 0 } })
    const { t, run } = makeRun(SIMPLE, p)
    expect(await run.run()).toBe('done')
    expect(t.sent.filter((l) => l === '$H')).toHaveLength(1)
    expect(t.sent[0]).toBe('$H') // before everything else
    expect(t.sent).toContain('G0 Z5.000')
    expect(t.sent).toContain('G1 Z0.000 F4000.000')
    expect(t.sent).not.toContain('M5')
  })

  it('unlocks an alarmed machine before streaming (no homing switches)', async () => {
    const t = new MockGrbl()
    t.injectAlarm(9) // pre-existing alarm state; the line itself is ignored (no session yet)
    const p = profile()
    const run = new GrblRun(planGrblTape(SIMPLE, p), new Grbl(t), p, hooks().h)
    expect(await run.run()).toBe('done')
    expect(t.sent[0]).toBe('$X')
  })

  it('honours the RX byte budget under slow acks', async () => {
    // A dense tape (many short draw segments) with slow acks piles lines into the window.
    const dense: Geometry = [stroke(Array.from({ length: 60 }, (_, i) => [i, (i * 7) % 13] as [number, number]))]
    const { t, run } = makeRun(dense, profile(), { ackDelayMs: 2 })
    expect(await run.run()).toBe('done')
    expect(t.maxUnackedBytes).toBeGreaterThan(30) // it actually pipelined...
    expect(t.maxUnackedBytes).toBeLessThanOrEqual(127) // ...within GRBL's ring
  })

  it('pauses only at a stroke boundary, drained and pen-up, and resumes', async () => {
    const many: Geometry = Array.from({ length: 20 }, (_, i) => stroke([[i * 5, 0], [i * 5 + 3, 0]]))
    const p = profile()
    const t = new MockGrbl({ ackDelayMs: (l) => (/^G[01]\b/.test(l) ? 10 : 0) })
    const { h, events } = hooks()
    const run = new GrblRun(planGrblTape(many, p), new Grbl(t), p, h)
    const done = run.run()
    setTimeout(() => run.requestPause(), 50)
    await vi.waitFor(() => expect(events).toContain('paused'))
    const atPause = t.sent.length
    run.requestResume()
    expect(await done).toBe('done')
    expect(events).toEqual(['paused', 'resumed'])
    // The pause landed between strokes: the last thing before it was a pen-up (M3 S750 + dwell).
    const before = t.sent.slice(0, atPause)
    const lastPen = [...before].reverse().find((l) => l.startsWith('M3'))
    expect(lastPen).toBe('M3 S750')
  })

  it('drains and prompts at a pen swap; declining cancels with hold + reset + walk home', async () => {
    const geom: Geometry = [stroke([[10, 0], [20, 0]], 0), stroke([[10, 10], [20, 10]], 1)]
    const prompts: string[] = []
    const { t, run } = makeRun(geom, profile(), {}, {
      prompt: async (kind, pen) => {
        prompts.push(`${kind}:${pen}`)
        return false // operator hits Stop
      },
    })
    expect(await run.run()).toBe('cancelled')
    expect(prompts).toEqual(['penSwap:1'])
    // Cancel recovery: modes re-asserted after reset, pen up, home, M5. Nothing from stroke 2.
    const resetIdx = t.sent.lastIndexOf('G21')
    expect(resetIdx).toBeGreaterThan(0) // a second G21 after the reset
    expect(t.sent.slice(resetIdx)).toEqual(['G21', 'G90', 'G54', 'M3 S750', 'G4 P0.300', 'G0 X0 Y0', 'M5'])
    expect(t.sent).not.toContain('G1 X20.000 Y10.000')
  })

  it('cancel mid-stream does not wait for buffered motion', async () => {
    const dense: Geometry = [stroke(Array.from({ length: 80 }, (_, i) => [i, 0] as [number, number]))]
    const { t, run } = makeRun(dense, profile(), { ackDelayMs: (l) => (/^G1\b/.test(l) ? 50 : 0) })
    const done = run.run()
    await vi.waitFor(() => expect(t.sent.some((l) => l.startsWith('G1'))).toBe(true))
    const t0 = performance.now()
    run.requestCancel()
    expect(await done).toBe('cancelled')
    // ~14 lines were in the window at 50ms each ≈ 700ms if cancel had queued behind acks.
    expect(performance.now() - t0).toBeLessThan(300)
    expect(t.sent.at(-1)).toBe('M5')
  })

  it('reports machine-driven playhead distance, monotonically', async () => {
    const p = profile()
    const t = new MockGrbl({ ackDelayMs: 2 })
    const { h, dists } = hooks()
    const run = new GrblRun(planGrblTape(SIMPLE, p), new Grbl(t), p, h)
    // Poke extra status queries while running so the 200ms poll isn't the only source.
    const poker = setInterval(() => t.write('?'), 5)
    try {
      expect(await run.run()).toBe('done')
    } finally {
      clearInterval(poker)
    }
    expect(dists.length).toBeGreaterThan(0)
    expect(dists).toEqual([...dists].sort((a, b) => a - b))
    expect(dists.at(-1)).toBeLessThanOrEqual(20.001) // never past the toolpath's end
  })

  it('an error:N ack aborts the run', async () => {
    const { run } = makeRun(SIMPLE, profile(), {
      reply: (l) => (l.startsWith('G1 X20') ? ['error:33'] : null),
    })
    await expect(run.run()).rejects.toMatchObject({ code: 33 })
  })

  it('an async ALARM aborts the run', async () => {
    const dense: Geometry = [stroke(Array.from({ length: 40 }, (_, i) => [i, 0] as [number, number]))]
    const { t, run } = makeRun(dense, profile(), { ackDelayMs: 5 })
    const done = run.run()
    await vi.waitFor(() => expect(t.sent.some((l) => l.startsWith('G1'))).toBe(true))
    t.injectAlarm(1)
    await expect(done).rejects.toMatchObject({ code: 1 })
  })

  it('mid-plot disconnect rejects the run', async () => {
    const { t, run } = makeRun(SIMPLE, profile(), { ackDelayMs: 20 })
    const done = run.run()
    setTimeout(() => t.unplug(), 30)
    await expect(done).rejects.toThrow('disconnected')
  })

  it('an empty tape completes without touching the board', async () => {
    const { t, run } = makeRun([], profile())
    expect(await run.run()).toBe('done')
    expect(t.sent).toEqual([])
  })
})
