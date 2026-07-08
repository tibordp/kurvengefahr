// Live end-to-end test against a real EBB board (or a firmware-faithful mock) on a serial device.
// Opt-in: set EBB_DEVICE=/dev/cu.usbmodemXXXX — skipped entirely otherwise, so CI never needs
// hardware. Drives the exact same Ebb/PlotRun classes the app uses, through a Node fs transport
// instead of Web Serial.
import { execSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { SEG, type PlotPlan } from '../../core/pipeline/planTypes'
import type { EbbTransport } from './transport'
import { Ebb } from './protocol'
import { PlotRun, type SessionHooks } from './session'

const DEVICE = process.env.EBB_DEVICE

/** ~1000 steps/s in LM rate units (steps/s · 2³¹ / 25000). */
const RATE_1K = 85899346

class NodeSerialTransport implements EbbTransport {
  private lineCb: (line: string) => void = () => {}
  private disconnectCb: () => void = () => {}
  private closed = false

  private constructor(private fh: FileHandle) {}

  static async open(device: string): Promise<NodeSerialTransport> {
    // Raw mode: no echo / newline translation from the tty layer (USB CDC ignores the baud).
    execSync(`stty -f ${device} raw`)
    // Non-blocking: a blocking char-device read can never be cancelled, which would wedge both
    // FileHandle.close() and process exit. Poll with a short sleep instead.
    const fh = await open(device, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY)
    const t = new NodeSerialTransport(fh)
    void t.readLoop()
    return t
  }

  private async readLoop(): Promise<void> {
    const buf = Buffer.alloc(4096)
    let pending = ''
    try {
      while (!this.closed) {
        let bytesRead = 0
        try {
          ;({ bytesRead } = await this.fh.read(buf, 0, buf.length, null))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
            await new Promise((r) => setTimeout(r, 5))
            continue
          }
          throw e
        }
        if (bytesRead === 0) {
          await new Promise((r) => setTimeout(r, 5))
          continue
        }
        pending += buf.subarray(0, bytesRead).toString('ascii')
        const parts = pending.split(/[\r\n]+/)
        pending = parts.pop() ?? ''
        for (const line of parts) if (line) this.lineCb(line)
      }
    } catch {
      if (!this.closed) this.disconnectCb()
    }
  }

  async write(data: string): Promise<void> {
    await this.fh.write(data, null, 'ascii')
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb
  }

  async close(): Promise<void> {
    this.closed = true
    await this.fh.close().catch(() => {})
  }
}

interface SegSpec {
  kind: number
  steps?: [number, number]
  rate?: number
  durationMs?: number
  pen?: number
  blockStart?: boolean
}

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
    plan.rate1[i] = s.steps?.[0] ? (s.rate ?? RATE_1K) : 0
    plan.rate2[i] = s.steps?.[1] ? (s.rate ?? RATE_1K) : 0
    plan.durationMs[i] = s.durationMs ?? 100
    plan.pen[i] = s.pen ?? 0
    plan.blockStart[i] = s.blockStart === false ? 0 : 1
    plan.totalDurationMs += plan.durationMs[i]
  })
  return plan
}

const SERVO = { upPercent: 60, downPercent: 30, liftMs: 100, dropMs: 100 }
const MOTION = { travelSpeed: 100, stepsPerMm: 80 }

describe.runIf(!!DEVICE)('live EBB', () => {
  async function connect(): Promise<{ ebb: Ebb; done: () => Promise<void> }> {
    const t = await NodeSerialTransport.open(DEVICE!)
    const ebb = new Ebb(t)
    return { ebb, done: () => ebb.close() }
  }

  it('talks the protocol: version, motion query, steps round-trip', async () => {
    const { ebb, done } = await connect()
    try {
      expect(await ebb.version()).toContain('Firmware Version')
      const m = await ebb.queryMotion()
      expect(m.executing).toBe(false)
      await ebb.enableMotors()
      await ebb.clearSteps()
      await ebb.move(100, 160, 160)
      await ebb.move(100, -160, -160)
      // Let the two moves finish before reading the counters.
      for (;;) {
        const q = await ebb.queryMotion()
        if (!q.executing && !q.fifo && !q.motor1 && !q.motor2) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(await ebb.querySteps()).toEqual([0, 0])
      await ebb.disableMotors()
    } finally {
      await done()
    }
  }, 15000)

  it('runs a full PlotRun tape with a mid-plot pause and resume', async () => {
    const { ebb, done } = await connect()
    // Two short "strokes": all step deltas sum to zero (the tape walks back home), 1000 steps/s.
    const plan = makePlan([
      { kind: SEG.penUp },
      { kind: SEG.motion, steps: [200, 200] }, // travel
      { kind: SEG.penDown },
      { kind: SEG.motion, steps: [100, -100], blockStart: true },
      { kind: SEG.motion, steps: [100, -100], blockStart: false },
      { kind: SEG.motion, steps: [100, -100], blockStart: true },
      { kind: SEG.penUp },
      { kind: SEG.motion, steps: [-500, 100] }, // home
    ])
    const events: string[] = []
    const hooks: SessionHooks = {
      onProgress: (i) => events.push(`seg${i}`),
      onPaused: () => events.push('paused'),
      onResumed: () => events.push('resumed'),
      prompt: async () => true,
    }
    const run = new PlotRun(plan, ebb, SERVO, MOTION, hooks)
    try {
      const finished = run.run()
      setTimeout(() => run.requestPause(), 150)
      const poll = setInterval(() => {
        if (events.includes('paused')) {
          clearInterval(poll)
          run.requestResume()
        }
      }, 50)
      expect(await finished).toBe('done')
      clearInterval(poll)
      expect(events).toContain('paused')
      expect(events).toContain('resumed')
      expect(events.filter((e) => e.startsWith('seg'))).toHaveLength(plan.length)
      // After EM the counters are cleared, but the board must be idle and happy.
      const m = await ebb.queryMotion()
      expect(m.executing).toBe(false)
    } finally {
      await done()
    }
  }, 30000)

  it('plots a real Rust-planned tape end-to-end (fiducial + pen swap prompts)', async () => {
    // The full chain minus the browser: geometry → wasm planner → PlotRun → real firmware.
    const { readFileSync } = await import('node:fs')
    const wasm = await import('@wasm/kg_core.js')
    await wasm.default({
      module_or_path: readFileSync(new URL('../../../crate/pkg/kg_core_bg.wasm', import.meta.url)),
    })
    const { flatten } = await import('../../core/wasm/serde')

    // A 40 mm square on pen 0 and a diagonal on pen 1 (already "optimized": pens contiguous).
    const square = [
      { x: 20, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 60 },
      { x: 20, y: 60 },
      { x: 20, y: 20 },
    ]
    const diag = [
      { x: 30, y: 30 },
      { x: 50, y: 50 },
    ]
    const geom = [
      { points: square, pen: 0, reversible: true, group: 0 },
      { points: diag, pen: 1, reversible: true, group: 0 },
    ]
    const flat = flatten(geom)
    const res = wasm.plan_axidraw(
      flat.xy,
      flat.pressure,
      flat.offsets,
      flat.pen,
      flat.reversible,
      flat.group,
      JSON.stringify({
        stepsPerMm: 80,
        drawSpeed: 150,
        travelSpeed: 300,
        acceleration: 3000,
        cornering: 0.127,
        liftMs: 50,
        dropMs: 50,
        start: [0, 0],
        fiducial: [10, 10],
        maxBlockSeconds: 5,
      }),
    )
    const plan: PlotPlan = {
      kind: res.kind,
      steps1: res.steps1,
      steps2: res.steps2,
      rate1: res.rate1,
      rate2: res.rate2,
      delta1: res.delta1,
      delta2: res.delta2,
      durationMs: res.duration_ms,
      dist: res.dist,
      x: res.x,
      y: res.y,
      pen: res.pen,
      blockStart: res.block_start,
      totalDurationMs: res.total_duration_ms,
      totalDist: res.total_dist,
      length: res.kind.length,
    }
    res.free()
    expect(plan.length).toBeGreaterThan(0)

    const { ebb, done } = await connect()
    const prompts: string[] = []
    const dists: number[] = []
    const hooks: SessionHooks = {
      onProgress: (i) => dists.push(plan.dist[i]),
      onPaused: () => {},
      onResumed: () => {},
      prompt: async (kind, pen) => {
        prompts.push(`${kind}:${pen}`)
        return true
      },
    }
    try {
      const run = new PlotRun(plan, ebb, { ...SERVO, liftMs: 50, dropMs: 50 }, MOTION, hooks)
      expect(await run.run()).toBe('done')
      expect(prompts).toEqual(['fiducial:0', 'penSwap:1'])
      // Progress is monotonic and reaches the plan's total preview distance.
      for (let i = 1; i < dists.length; i++) expect(dists[i]).toBeGreaterThanOrEqual(dists[i - 1])
      expect(dists.at(-1)).toBeCloseTo(plan.totalDist, 3)
      const m = await ebb.queryMotion()
      expect(m.executing).toBe(false)
    } finally {
      await done()
    }
  }, 60000)

  it('cancel emergency-stops and walks home from the real step counters', async () => {
    const { ebb, done } = await connect()
    const plan = makePlan(
      // One long stroke of many 100 ms blocks — cancel lands mid-flight.
      [
        { kind: SEG.penUp },
        ...Array.from({ length: 40 }, () => ({
          kind: SEG.motion,
          steps: [100, 100] as [number, number],
        })),
      ],
    )
    const events: string[] = []
    const hooks: SessionHooks = {
      onProgress: (i) => events.push(`seg${i}`),
      onPaused: () => {},
      onResumed: () => {},
      prompt: async () => true,
    }
    const run = new PlotRun(plan, ebb, SERVO, MOTION, hooks)
    try {
      const finished = run.run()
      setTimeout(() => run.requestCancel(), 500)
      expect(await finished).toBe('cancelled')
      // The machine is idle after the cancel's walk-home.
      const m = await ebb.queryMotion()
      expect(m.executing).toBe(false)
      expect(m.fifo).toBe(false)
    } finally {
      await done()
    }
  }, 30000)
})
