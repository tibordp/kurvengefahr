import { describe, expect, it, vi } from 'vitest'
import { SEG, type PlotPlan } from '../../core/pipeline/planTypes'
import { Ebb } from './protocol'
import { MockTransport } from './mock'
import { PlotRun, type SessionHooks } from './session'

interface SegSpec {
  kind: number
  steps?: [number, number]
  durationMs?: number
  pen?: number
  blockStart?: boolean
}

/** Hand-build a tape (the Rust planner's output shape) from terse specs. */
function makePlan(specs: SegSpec[]): PlotPlan {
  const n = specs.length
  const plan: PlotPlan = {
    kind: new Uint8Array(n),
    steps1: new Int32Array(n),
    steps2: new Int32Array(n),
    rate1: new Int32Array(n),
    rate2: new Int32Array(n),
    delta1: new Int32Array(n),
    delta2: new Int32Array(n),
    durationMs: new Float32Array(n),
    dist: new Float32Array(n),
    x: new Float32Array(n),
    y: new Float32Array(n),
    pen: new Uint16Array(n),
    blockStart: new Uint8Array(n),
    totalDurationMs: 0,
    totalDist: 0,
    length: n,
  }
  specs.forEach((s, i) => {
    plan.kind[i] = s.kind
    plan.steps1[i] = s.steps?.[0] ?? 0
    plan.steps2[i] = s.steps?.[1] ?? 0
    plan.rate1[i] = s.steps ? 100000 : 0
    plan.rate2[i] = s.steps ? 100000 : 0
    plan.durationMs[i] = s.durationMs ?? 10
    plan.pen[i] = s.pen ?? 0
    plan.blockStart[i] = s.blockStart === false ? 0 : 1
    plan.totalDurationMs += plan.durationMs[i]
  })
  return plan
}

const SERVO = { upPercent: 60, downPercent: 30, liftMs: 5, dropMs: 5 }
const MOTION = { travelSpeed: 100, stepsPerMm: 80 }

function hooks(overrides: Partial<SessionHooks> = {}) {
  const progressed: number[] = []
  const events: string[] = []
  const h: SessionHooks = {
    onProgress: (i) => progressed.push(i),
    onPaused: () => events.push('paused'),
    onResumed: () => events.push('resumed'),
    prompt: async () => true,
    ...overrides,
  }
  return { h, progressed, events }
}

/** A simple three-segment stroke: travel, pen down, draw, pen up. */
const SIMPLE: SegSpec[] = [
  { kind: SEG.penUp },
  { kind: SEG.motion, steps: [100, 100] },
  { kind: SEG.penDown },
  { kind: SEG.motion, steps: [80, -80] },
  { kind: SEG.penUp },
  { kind: SEG.motion, steps: [-180, -20] },
]

describe('PlotRun', () => {
  it('runs the tape: setup, LM motion, pen moves, drain, motors off', async () => {
    const t = new MockTransport()
    const { h, progressed } = hooks()
    const run = new PlotRun(makePlan(SIMPLE), new Ebb(t), SERVO, MOTION, h)
    expect(await run.run()).toBe('done')
    // Setup prefix.
    expect(t.sent.slice(0, 6)).toEqual(['V', 'EM,1,1', 'SC,4,19800', 'SC,5,13650', 'SP,1,5', 'CS'])
    // Motion goes out as LM on 3.x firmware, with accumulator clears at rest points.
    const lm = t.sent.filter((c) => c.startsWith('LM'))
    expect(lm).toHaveLength(3)
    expect(lm[0]).toBe('LM,100000,100,0,100000,100,0,3')
    // Winds down: drained then motors off.
    expect(t.sent.at(-1)).toBe('EM,0,0')
    expect(t.sent.at(-2)).toBe('QM')
    expect(progressed).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('falls back to SM on pre-2.7 firmware', async () => {
    const t = new MockTransport({ version: 'EBBv13_and_above EB Firmware Version 2.5.4' })
    const { h } = hooks()
    const run = new PlotRun(makePlan(SIMPLE), new Ebb(t), SERVO, MOTION, h)
    await run.run()
    expect(t.sent.some((c) => c.startsWith('SM,'))).toBe(true)
    expect(t.sent.some((c) => c.startsWith('LM'))).toBe(false)
  })

  it('pauses only at block boundaries and restores pen state on resume', async () => {
    // A long stroke of forced-rest blocks. Segment durations exceed the send-ahead window and
    // motion acks are slow, so the feed loop is still mid-tape when the pause request arrives.
    const plan = makePlan([
      { kind: SEG.penUp },
      { kind: SEG.motion, steps: [100, 100], durationMs: 300 },
      { kind: SEG.penDown },
      ...Array.from({ length: 10 }, (_, k) => ({
        kind: SEG.motion,
        steps: [50, 50] as [number, number],
        durationMs: 300,
        blockStart: k % 2 === 0, // every other segment is NOT a safe boundary
      })),
      { kind: SEG.penUp },
    ])
    const t = new MockTransport({ ackDelayMs: (c) => (c.startsWith('LM') ? 20 : 1) })
    const { h, events } = hooks()
    const run = new PlotRun(plan, new Ebb(t), SERVO, MOTION, h)
    const done = run.run()
    // Ask once the feed is mid-stroke (pen down), so resume has real pen state to restore.
    setTimeout(() => run.requestPause(), 100)
    // Wait until the session reports the pause, then resume.
    await vi.waitFor(() => expect(events).toContain('paused'))
    const sentAtPause = t.sent.length
    run.requestResume()
    expect(await done).toBe('done')
    expect(events).toEqual(['paused', 'resumed'])
    // While paused inside the stroke, the pen was lifted (SP,1) and re-dropped (SP,0) on resume.
    const afterPause = t.sent.slice(sentAtPause)
    expect(afterPause.some((c) => c.startsWith('SP,0'))).toBe(true)
  })

  it('prompt(stop) cancels: ES, pen up, walk home from QS, motors off', async () => {
    const plan = makePlan([
      { kind: SEG.penUp },
      { kind: SEG.motion, steps: [100, 100] },
      { kind: SEG.pausePenswap, pen: 2 },
      { kind: SEG.motion, steps: [50, 50] },
    ])
    const t = new MockTransport({ reply: (c) => (c === 'QS' ? ['800,0'] : null) })
    const prompts: string[] = []
    const { h } = hooks({
      prompt: async (kind, pen) => {
        prompts.push(`${kind}:${pen}`)
        return false // operator hits Stop
      },
    })
    const run = new PlotRun(plan, new Ebb(t), SERVO, MOTION, h)
    expect(await run.run()).toBe('cancelled')
    expect(prompts).toEqual(['penSwap:2'])
    expect(t.sent).toContain('ES')
    // QS said (800, 0) steps → walk home is the negation, at travel speed: 800 = x+y steps,
    // 0 = x−y → (dx, dy) = (5, 5) mm → hypot ≈ 7.07 mm at 100 mm/s ≈ 71 ms.
    const home = t.sent.find((c) => c.startsWith('SM,') && c.endsWith(',-800,0'))
    expect(home).toBeDefined()
    expect(t.sent.at(-1)).toBe('EM,0,0')
  })

  it('the hardware button pauses the run', async () => {
    const plan = makePlan(
      Array.from({ length: 40 }, () => ({
        kind: SEG.motion,
        steps: [10, 10] as [number, number],
        durationMs: 300, // exceed the send-ahead window so the feed loop stays live
      })),
    )
    const t = new MockTransport({ ackDelayMs: (c) => (c.startsWith('LM') ? 30 : 1) })
    const { h, events } = hooks()
    const run = new PlotRun(plan, new Ebb(t), SERVO, MOTION, h)
    const done = run.run()
    setTimeout(() => t.pressButton(), 300)
    await vi.waitFor(() => expect(events).toContain('paused'), { timeout: 8000 })
    run.requestResume()
    expect(await done).toBe('done')
  }, 15000)

  it('cancel while paused homes and stops', async () => {
    const plan = makePlan(
      Array.from({ length: 12 }, () => ({
        kind: SEG.motion,
        steps: [10, 10] as [number, number],
        durationMs: 300,
      })),
    )
    const t = new MockTransport({ ackDelayMs: (c) => (c.startsWith('LM') ? 20 : 1) })
    const { h, events } = hooks()
    const run = new PlotRun(plan, new Ebb(t), SERVO, MOTION, h)
    const done = run.run()
    run.requestPause()
    await vi.waitFor(() => expect(events).toContain('paused'))
    run.requestCancel()
    expect(await done).toBe('cancelled')
    expect(t.sent).toContain('ES')
    expect(t.sent.at(-1)).toBe('EM,0,0')
  })

  it('mid-plot disconnect rejects the run', async () => {
    const plan = makePlan(SIMPLE)
    const t = new MockTransport({ ackDelayMs: 20 })
    const { h } = hooks()
    const run = new PlotRun(plan, new Ebb(t), SERVO, MOTION, h)
    const done = run.run()
    setTimeout(() => t.unplug(), 30)
    await expect(done).rejects.toThrow('disconnected')
  })

  it('an empty tape completes without touching the board', async () => {
    const t = new MockTransport()
    const { h } = hooks()
    const run = new PlotRun(makePlan([]), new Ebb(t), SERVO, MOTION, h)
    expect(await run.run()).toBe('done')
    expect(t.sent).toEqual([])
  })
})
