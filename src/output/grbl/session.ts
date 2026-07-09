// The streaming plot session: executes a GrblTape against a Grbl board.
//
// Flow control is **character counting** against GRBL's 128-byte RX ring (the standard streaming
// mode — grbl's own stream.py, UGS, cncjs): lines are sent while the unacked byte total fits
// RX_BUDGET, so GRBL's parser and planner never starve between short segments, and never overflow.
// An `ok` means "parsed into the planner", NOT "executed" — when the planner queue is full the
// oldest ack can lag by seconds of buffered motion, so every blocking ack-wait races the cancel
// signal: cancel never queues behind motion.
//
// Progress is reported two ways, deliberately:
//   • `onProgress(i)` when a segment's last line acks — coarse, runs ahead of the pen by the
//     buffer depth (bounded by the tape's MAX_SEG_MM splitting);
//   • `onDist(mm)` from `?` status reports (~5 Hz): the reported work position is projected
//     forward-monotonically onto the tape — the playhead follows the *machine*, not an estimate.
//
// Pause lands only on `blockStart` segments (start-of-stroke travels — the pen is already up
// there), then drains to Idle. Feed hold (`!`) is reserved for **cancel**: hold → wait Hold:0 →
// soft reset (position survives a completed hold; the ring and planner are flushed) → `$X` if
// alarmed → re-assert modes (reset cleared them; the `G10 L20` work offset survives in EEPROM) →
// pen up → walk home to work zero.
import { SEG } from '../../core/pipeline/planTypes'
import type { GrblTape } from '../../core/pipeline/grblTape'
import { grblEndLines, grblInitLines, grblPenLines, grblSegmentLines, newEmitCtx } from '../../core/pipeline/emitGrbl'
import type { GrblProfile } from '../../core/types'
import type { SessionHooks } from '../session'
import { Grbl, GrblError, type GrblStatus } from './protocol'

export interface GrblSessionHooks extends SessionHooks {
  /** Machine-reported progress along the tape (mm of `dist`), monotonic — drives the playhead. */
  onDist(mm: number): void
}

/** GRBL 1.1's RX ring is 128 bytes; leave one spare (the classic char-counting budget). */
const RX_BUDGET = 127
const STATUS_POLL_MS = 200
const DRAIN_POLL_MS = 50
/** How close (mm) a reported position must sit to a tape segment to advance the playhead —
 *  covers the report's 0.001 rounding and the tape's Float32 storage. */
const PROJECT_EPS_MM = 0.1

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A sent-but-unacked line. The promise is pre-settled to `Error | null` so a burst of rejections
 *  (unplug, soft reset) never surfaces as an unhandled rejection before the loop dequeues it. */
interface Inflight {
  /** Tape segment to report when this line acks, if it's the segment's last line. */
  i?: number
  bytes: number
  settled: Promise<Error | null>
}

export class GrblRun {
  private pauseFlag = false
  private cancelFlag = false
  private wake: (() => void) | null = null
  private cancelSignal: Promise<'cancel'>
  private signalCancel!: () => void
  private inflight: Inflight[] = []
  private inflightBytes = 0
  private fatal: Error | null = null
  private statusWaiters: { resolve: (s: GrblStatus) => void; reject: (e: Error) => void }[] = []
  /** Forward-monotonic projection state: the segment cursor and the playhead distance. */
  private projIndex = 0
  private projDist = 0
  /** Highest acked tape index — the machine cannot be executing past it. */
  private acked = -1
  private ctx = newEmitCtx()

  constructor(
    private tape: GrblTape,
    private grbl: Grbl,
    private profile: GrblProfile,
    private hooks: GrblSessionHooks,
  ) {
    this.cancelSignal = new Promise((resolve) => {
      this.signalCancel = () => resolve('cancel')
    })
    grbl.onStatus((s) => this.handleStatus(s))
    grbl.onAlarm((code) => {
      this.fatal ??= new GrblError(`ALARM:${code}`, code)
      this.wake?.()
    })
    grbl.onDisconnect(() => {
      this.fatal ??= new GrblError('GRBL disconnected')
      for (const w of this.statusWaiters.splice(0)) w.reject(this.fatal)
      this.wake?.()
    })
  }

  /** Ask the loop to pause at the next safe segment boundary (start of a stroke, pen up). */
  requestPause(): void {
    this.pauseFlag = true
  }

  requestResume(): void {
    this.pauseFlag = false
    this.wake?.()
  }

  /** Abort: feed hold, soft reset, pen up, walk home to work zero. Takes effect immediately —
   *  cancel is raced against every blocking ack, never queued behind buffered motion. */
  requestCancel(): void {
    this.cancelFlag = true
    this.signalCancel()
    this.wake?.()
  }

  /** Run the tape to completion. Throws GrblError on disconnect/error/alarm — the work origin is
   *  still trustworthy afterwards only if the machine wasn't moved by hand. */
  async run(): Promise<'done' | 'cancelled'> {
    const { tape, grbl, profile } = this
    if (tape.length === 0) return 'done'

    const poll = setInterval(() => grbl.statusQuery(), STATUS_POLL_MS)
    try {
      // Setup: clear an alarm lock (homing if the machine can, else unlock — "position unknown"
      // is fine, the work origin is declared below), then home if configured.
      const initial = await this.status()
      if (initial.state === 'Alarm') {
        if (profile.homing) await grbl.home()
        else await grbl.unlock()
      } else if (profile.homing) {
        await grbl.home()
      }

      // User preamble, then the generated init (modes, work zero, pen up) — same order as the
      // downloaded artifact; $H is excluded because it just ran interactively above.
      for (const line of this.templateLines(profile.preamble)) await this.sendLine(line)
      for (const line of grblInitLines(profile, false)) await this.sendLine(line)

      let penDown = false
      for (let i = 0; i < tape.length; i++) {
        if (this.fatal) throw this.fatal
        if (this.cancelFlag) {
          await this.doCancel()
          return 'cancelled'
        }
        if (this.pauseFlag && tape.blockStart[i]) {
          await this.flushInflight()
          await this.drain()
          if (penDown) for (const l of grblPenLines(profile, 'up', 0, this.ctx)) await this.sendLine(l)
          this.hooks.onPaused()
          await this.waitWhilePaused()
          if (this.cancelFlag) {
            await this.doCancel()
            return 'cancelled'
          }
          if (this.fatal) throw this.fatal
          if (penDown)
            for (const l of grblPenLines(profile, 'down', tape.pressure[i], this.ctx)) await this.sendLine(l)
          this.hooks.onResumed()
        }

        const kind = tape.kind[i]
        if (kind === SEG.pauseFiducial || kind === SEG.pausePenswap) {
          await this.flushInflight()
          await this.drain()
          const go = await this.hooks.prompt(kind === SEG.pauseFiducial ? 'fiducial' : 'penSwap', tape.pen[i])
          if (!go || this.cancelFlag) {
            await this.doCancel()
            return 'cancelled'
          }
          this.acked = i
          this.hooks.onProgress(i)
          continue
        }
        if (kind === SEG.penDown) penDown = true
        else if (kind === SEG.penUp) penDown = false
        const lines = grblSegmentLines(tape, i, profile, this.ctx)
        for (let l = 0; l < lines.length; l++) {
          await this.sendLine(lines[l], l === lines.length - 1 ? i : undefined)
          if (this.cancelFlag || this.fatal) break
        }
      }

      if (this.fatal) throw this.fatal
      if (this.cancelFlag) {
        await this.doCancel()
        return 'cancelled'
      }

      // The tape ends at work zero; wait for the machine to actually get there, then wind down.
      await this.flushInflight()
      await this.drain()
      for (const line of grblEndLines(profile)) await this.sendLine(line)
      for (const line of this.templateLines(profile.postamble)) await this.sendLine(line)
      await this.flushInflight()
      return 'done'
    } finally {
      clearInterval(poll)
    }
  }

  private templateLines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  }

  /** Send one line under the character-counting window: wait (acking oldest) until it fits the
   *  RX budget. `i` marks the tape segment this line completes, reported on its ack. */
  private async sendLine(line: string, i?: number): Promise<void> {
    const bytes = line.length + 1
    // A pathological user preamble line longer than the ring can never fit alongside others —
    // send it alone against an empty window (GRBL still buffers it as it parses).
    while (this.inflightBytes > 0 && this.inflightBytes + bytes > RX_BUDGET) {
      await this.ackOldest()
      if (this.cancelFlag || this.fatal) return
    }
    if (this.cancelFlag || this.fatal) return
    const sent = this.grbl.send(line)
    this.inflight.push({
      i,
      bytes,
      settled: sent.then(
        () => null,
        (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
      ),
    })
    this.inflightBytes += bytes
  }

  /** Ack the oldest in-flight line, racing the cancel signal — a held/backed-up machine must not
   *  block cancel. On cancel the entry stays queued; doCancel's reset settles it harmlessly. */
  private async ackOldest(): Promise<void> {
    const entry = this.inflight[0]
    if (!entry) return
    const result = await Promise.race([entry.settled, this.cancelSignal])
    if (result === 'cancel') return
    this.inflight.shift()
    this.inflightBytes -= entry.bytes
    if (result) throw result
    if (entry.i !== undefined) {
      this.acked = entry.i
      this.hooks.onProgress(entry.i)
    }
  }

  /** Barrier: wait out (and ack) everything in flight. */
  private async flushInflight(): Promise<void> {
    while (this.inflight.length > 0) {
      await this.ackOldest()
      if (this.cancelFlag || this.fatal) return
    }
  }

  /** One `?` round-trip. The poll interval also feeds `handleStatus`; this just needs the next
   *  report, whoever asked for it. */
  private status(): Promise<GrblStatus> {
    if (this.fatal) return Promise.reject(this.fatal)
    const p = new Promise<GrblStatus>((resolve, reject) => {
      this.statusWaiters.push({ resolve, reject })
    })
    this.grbl.statusQuery()
    return p
  }

  /** `status()` with a deadline — for probing a board that may not answer (mid-reset). A stale
   *  waiter left behind by a timeout is harmless: the next report resolves it unread. */
  private statusWithin(ms: number): Promise<GrblStatus | null> {
    return Promise.race([this.status().catch(() => null), sleep(ms).then(() => null)])
  }

  private handleStatus(s: GrblStatus): void {
    for (const w of this.statusWaiters.splice(0)) w.resolve(s)
    if (s.wpos) this.project(s.wpos)
  }

  /** Wait until the machine reports Idle — everything sent has been executed. */
  private async drain(): Promise<void> {
    for (;;) {
      if (this.cancelFlag || this.fatal) return
      const s = await this.status()
      if (s.state === 'Idle') return
      await sleep(DRAIN_POLL_MS)
    }
  }

  private waitWhilePaused(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        this.wake = null
        resolve()
      }
      // resume/cancel/alarm may already have arrived between the check and here
      if (!this.pauseFlag || this.cancelFlag || this.fatal) this.wake()
    })
  }

  /** Project a reported work position onto the tape: scan motion segments forward from the
   *  cursor (never past the last acked line — the machine can't be executing what it hasn't
   *  buffered), take the first one the point lies on, and advance the monotonic playhead. */
  private project(pos: { x: number; y: number }): void {
    const { tape } = this
    for (let i = Math.max(this.projIndex, 0); i <= Math.min(this.acked, tape.length - 1); i++) {
      if (tape.kind[i] !== SEG.motion) continue
      const x0 = i > 0 ? tape.x[i - 1] : 0
      const y0 = i > 0 ? tape.y[i - 1] : 0
      const dx = tape.x[i] - x0
      const dy = tape.y[i] - y0
      const len = Math.hypot(dx, dy)
      const t = len > 0 ? Math.min(1, Math.max(0, ((pos.x - x0) * dx + (pos.y - y0) * dy) / (len * len))) : 0
      const px = x0 + dx * t
      const py = y0 + dy * t
      if (Math.hypot(pos.x - px, pos.y - py) <= PROJECT_EPS_MM) {
        const segStart = i > 0 ? tape.dist[i - 1] : 0
        const covered = segStart + (tape.dist[i] - segStart) * t
        this.projIndex = i
        if (covered > this.projDist) {
          this.projDist = covered
          this.hooks.onDist(covered)
        }
        return
      }
    }
  }

  /** Cancel recovery — see the module header. Every await here uses the protocol directly (the
   *  windowed sender is done for): the reset flushed GRBL's buffers, so ordering is simple again. */
  private async doCancel(): Promise<void> {
    const { grbl, profile } = this
    try {
      grbl.feedHold()
      // Wait for the deceleration to complete — resetting mid-motion loses steps.
      for (;;) {
        const s = await this.status()
        if (s.state === 'Idle' || (s.state === 'Hold' && s.sub === 0)) break
        await sleep(DRAIN_POLL_MS)
      }
      try {
        await grbl.softReset(1500)
      } catch {
        // grblHAL resets silently from a latched alarm (no banner) — liveness is probed below.
      }
      // The reset rejected every in-flight ack; the pre-settled promises absorb that.
      this.inflight.length = 0
      this.inflightBytes = 0
      this.fatal = null // the rejections above were self-inflicted
      let alive: GrblStatus | null = null
      for (let i = 0; i < 12 && !alive; i++) alive = await this.statusWithin(250)
      if (!alive) throw new GrblError('no response after reset')
      if (alive.state === 'Alarm') await grbl.unlock()
      // Reset cleared the modal state; the G10 L20 work offset survived.
      for (const line of ['G21', 'G90', 'G54']) await grbl.send(line)
      this.ctx = newEmitCtx()
      for (const line of grblPenLines(profile, 'up', 0, this.ctx)) await grbl.send(line)
      await grbl.send('G0 X0 Y0')
      for (;;) {
        const s = await this.status()
        if (s.state === 'Idle') break
        await sleep(DRAIN_POLL_MS)
      }
      for (const line of grblEndLines(profile)) await grbl.send(line)
    } catch (e) {
      // Best-effort: a disconnect mid-recovery leaves the machine where it is; surface the
      // original cancellation, not the recovery failure.
      console.warn('[kg] grbl cancel recovery incomplete:', e)
    }
  }
}
