// The streaming plot session: executes a PlotPlan tape against an Ebb.
//
// Commands are **pipelined**: a bounded window of segments stays in flight (the board's FIFO +
// USB buffer hold them), because strictly awaiting each OK adds a host round-trip between every
// command — on dense curves (many few-ms segments) that drains the motion FIFO and the machine
// visibly stutters. The window is bounded two ways, and both are load-bearing:
//   * by wall clock (`pace`): every segment's execution time is known exactly, so the loop never
//     *schedules* more than AHEAD_MS beyond real time — a device that acks at parse time (rather
//     than withholding OK while its FIFO is full) would otherwise let us blast the entire tape
//     into its tiny input buffer and drop bytes;
//   * by un-acked count/time (`pipeline`), so a real EBB's withheld-OK backpressure and transport
//     failures still surface promptly.
//
// Pause lands only on `blockStart` segments (the planner's zero-velocity rest points, never more
// than ~max_block_seconds apart), so resume is exact: lift the pen, wait, restore the pen state
// the tape expects, continue. Cancel is immediate: ES flushes the machine, QS recovers the true
// position (step counters were zeroed at home), and a single SM walks the carriage back.
import { SEG, type PlotPlan } from '../../core/pipeline/planTypes'
import type { PromptKind, SessionHooks } from '../session'
import { Ebb, supportsLM } from './protocol'

export type { PromptKind, SessionHooks } from '../session'

export interface ServoConfig {
  upPercent: number
  downPercent: number
  liftMs: number
  dropMs: number
}

export interface PlanMotion {
  travelSpeed: number
  stepsPerMm: number
}

const QB_POLL_MS = 500
const DRAIN_POLL_MS = 100
/** In-flight (sent, un-acked) budget: enough buffered motion to ride out host latency, small
 *  enough that pause lands quickly and cancel's ES isn't queued behind seconds of moves.
 *  The *count* cap also bounds bytes parked in the device's input buffer — while the EBB's
 *  command processor blocks on a full FIFO, un-acked commands pile up there, and a CDC
 *  implementation without USB-level pushback (measured on an STM32 EBB port) drops input beyond
 *  ~2 KB. 16 commands ≈ 0.6 KB, and still ~50 ms of lookahead at the ~3 ms/command ceiling —
 *  far more than a USB round-trip. */
const AHEAD_MS = 400
const AHEAD_MAX = 16

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A sent-but-unacked segment. The promise is pre-settled to `Error | null` so a burst of
 *  rejections (unplug) never surfaces as an unhandled rejection before the loop dequeues it. */
interface Inflight {
  i: number
  ms: number
  settled: Promise<Error | null>
}

export class PlotRun {
  private pauseFlag = false
  private cancelFlag = false
  private wake: (() => void) | null = null
  private inflight: Inflight[] = []
  private inflightMs = 0
  /** Estimated wall time (performance.now ms) at which the machine finishes everything sent. */
  private clock = 0

  constructor(
    private plan: PlotPlan,
    private ebb: Ebb,
    private servo: ServoConfig,
    private motion: PlanMotion,
    private hooks: SessionHooks,
  ) {}

  /** Ask the loop to pause at the next safe (zero-velocity) segment boundary. */
  requestPause(): void {
    this.pauseFlag = true
  }

  requestResume(): void {
    this.pauseFlag = false
    this.wake?.()
  }

  /** Abort: emergency-stop, pen up, walk home, motors off. Takes effect at the next ack. */
  requestCancel(): void {
    this.cancelFlag = true
    this.wake?.()
  }

  /** Run the tape to completion. Throws EbbError on disconnect/protocol failure — the machine's
   *  position is unknown to us after that (the operator re-parks the carriage). */
  async run(): Promise<'done' | 'cancelled'> {
    const { plan, ebb } = this
    if (plan.length === 0) return 'done'

    // Setup: pick the motion command dialect, motors on at 16×, servo range, pen up, and zero the
    // step counters — the operator parked the carriage at home, and this declares "home is here".
    const lm = supportsLM(await ebb.version())
    await ebb.enableMotors()
    await ebb.configureServo(this.servo.upPercent, this.servo.downPercent)
    await ebb.setPen(true, this.servo.liftMs)
    await ebb.clearSteps()

    let penDown = false
    let lastQb = Date.now()

    for (let i = 0; i < plan.length; i++) {
      await this.pace()
      if (this.cancelFlag) {
        await this.doCancel()
        return 'cancelled'
      }
      if (this.pauseFlag && plan.blockStart[i]) {
        await this.flushInflight()
        await this.drain()
        if (penDown) await ebb.setPen(true, this.servo.liftMs)
        this.hooks.onPaused()
        await this.waitWhilePaused()
        if (this.cancelFlag) {
          await this.doCancel()
          return 'cancelled'
        }
        // Restore the pen state the tape expects at this segment (a forced rest point can sit
        // mid-stroke, pen down).
        if (penDown) await ebb.setPen(false, this.servo.dropMs)
        this.hooks.onResumed()
      }

      switch (plan.kind[i]) {
        case SEG.motion: {
          // Clear the step accumulators at rest points for deterministic ramps.
          const sent = lm
            ? ebb.lowLevelMove(
                plan.rate1[i],
                plan.steps1[i],
                plan.delta1[i],
                plan.rate2[i],
                plan.steps2[i],
                plan.delta2[i],
                plan.blockStart[i] ? 3 : undefined,
              )
            : ebb.move(plan.durationMs[i], plan.steps1[i], plan.steps2[i])
          await this.pipeline(i, plan.durationMs[i], sent)
          break
        }
        case SEG.penDown:
          await this.pipeline(i, plan.durationMs[i], ebb.setPen(false, this.servo.dropMs))
          penDown = true
          break
        case SEG.penUp:
          await this.pipeline(i, plan.durationMs[i], ebb.setPen(true, this.servo.liftMs))
          penDown = false
          break
        case SEG.pauseFiducial:
        case SEG.pausePenswap: {
          await this.flushInflight()
          await this.drain()
          const kind: PromptKind = plan.kind[i] === SEG.pauseFiducial ? 'fiducial' : 'penSwap'
          const go = await this.hooks.prompt(kind, plan.pen[i])
          if (!go || this.cancelFlag) {
            await this.doCancel()
            return 'cancelled'
          }
          this.hooks.onProgress(i)
          break
        }
      }

      // The board's PRG button doubles as a physical pause request (latched, cleared by read).
      // Fired pipelined — awaiting the reply here would defeat the send-ahead window.
      if (Date.now() - lastQb > QB_POLL_MS) {
        lastQb = Date.now()
        void ebb
          .queryButton()
          .then((pressed) => {
            if (pressed) this.pauseFlag = true
          })
          .catch(() => {}) // a dying connection surfaces through the segment acks
      }
    }

    // The tape ends with the travel home; wait for the machine to actually finish it.
    await this.flushInflight()
    await this.drain()
    await ebb.disableMotors()
    return 'done'
  }

  /** Sleep until the already-sent work is within AHEAD_MS of real time. Short chunks keep cancel
   *  responsive; after any long stop (pause, prompt, drain) the clock snaps back to `now`. */
  private async pace(): Promise<void> {
    for (;;) {
      if (this.cancelFlag) return
      const now = performance.now()
      this.clock = Math.max(this.clock, now)
      const ahead = this.clock - now
      if (ahead <= AHEAD_MS) return
      await sleep(Math.min(ahead - AHEAD_MS, 100))
    }
  }

  /** Queue a sent segment and ack older ones once the in-flight window is over budget. Progress
   *  fires strictly in tape order (EBB replies are FIFO). Throws the first failed ack. */
  private async pipeline(i: number, ms: number, sent: Promise<unknown>): Promise<void> {
    this.clock += ms
    this.inflight.push({ i, ms, settled: sent.then(() => null, (e: unknown) => (e instanceof Error ? e : new Error(String(e)))) })
    this.inflightMs += ms
    while (this.inflightMs > AHEAD_MS || this.inflight.length > AHEAD_MAX) {
      await this.ackOldest()
    }
  }

  private async ackOldest(): Promise<void> {
    const entry = this.inflight.shift()
    if (!entry) return
    this.inflightMs -= entry.ms
    const err = await entry.settled
    if (err) throw err
    this.hooks.onProgress(entry.i)
  }

  /** Barrier: wait out (and ack) everything in flight. */
  private async flushInflight(): Promise<void> {
    while (this.inflight.length > 0) await this.ackOldest()
  }

  /** Wait until the motion queue is empty and both motors are still. */
  private async drain(): Promise<void> {
    for (;;) {
      const m = await this.ebb.queryMotion()
      if (!m.executing && !m.motor1 && !m.motor2 && !m.fifo) return
      await sleep(DRAIN_POLL_MS)
    }
  }

  private waitWhilePaused(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
      // resume/cancel may already have been requested between the check and here
      if (!this.pauseFlag || this.cancelFlag) this.wake()
    })
  }

  /** Emergency-stop, lift, recover the true position from the step counters (zeroed at home), walk
   *  back, motors off. */
  private async doCancel(): Promise<void> {
    const { ebb } = this
    await ebb.emergencyStop()
    await ebb.setPen(true, this.servo.liftMs)
    const [m1, m2] = await ebb.querySteps()
    const spmm = this.motion.stepsPerMm
    // Invert the axis mixing (m1 = x+y, m2 = x−y, in steps) for the homing distance/duration.
    const dx = (m1 + m2) / (2 * spmm)
    const dy = (m1 - m2) / (2 * spmm)
    if (m1 !== 0 || m2 !== 0) {
      const ms = (Math.hypot(dx, dy) / this.motion.travelSpeed) * 1000
      await ebb.move(ms, -m1, -m2)
      await this.drain()
    }
    await ebb.disableMotors()
  }
}
