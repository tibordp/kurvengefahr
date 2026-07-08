// The EBB (EiBotBoard) command protocol, legacy syntax mode (what every firmware boots into).
// One class, transport-agnostic: `command()` writes a CR-terminated command and resolves with the
// reply's data lines. Replies arrive strictly in command order, so response matching is a FIFO of
// waiters; writes are NOT held back for the previous reply — the natural EBB backpressure (the
// board withholds a motion command's OK while its FIFO is full) is applied by *callers* awaiting
// each command before sending the next (the streaming session does exactly that).
//
// Legacy framing quirks handled here (verified against real EBB 3.0.3 firmware):
//   * most replies are zero or more data lines followed by `OK`;
//   * `V` and `QM` reply with a single line and NO `OK`;
//   * errors are a line starting with `!` with NO trailing `OK` (3.x) — rejected immediately.
import type { EbbTransport } from './transport'

export class EbbError extends Error {}

/** Practical pen-servo pulse range on an AxiDraw (units of 83.3 ns): ~7500 = lowest position,
 *  ~28000 = highest. Profile percents map linearly onto this span (100% = fully up). */
const SERVO_MIN = 7500
const SERVO_MAX = 28000

export function servoPos(percent: number): number {
  const t = Math.min(100, Math.max(0, percent)) / 100
  return Math.round(SERVO_MIN + (SERVO_MAX - SERVO_MIN) * t)
}

export interface MotionStatus {
  executing: boolean
  motor1: boolean
  motor2: boolean
  fifo: boolean
}

interface Waiter {
  /** V / QM replies: exactly one line, no `OK` terminator. */
  singleLine: boolean
  lines: string[]
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
}

export class Ebb {
  private waiters: Waiter[] = []
  private closed = false
  private disconnectCbs: (() => void)[] = []

  constructor(private transport: EbbTransport) {
    transport.onLine((line) => this.handleLine(line))
    transport.onDisconnect(() => this.handleDisconnect())
  }

  /** Register a disconnect listener (the session aborts on it). */
  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb)
  }

  /** Deliberately close the connection: pending commands reject, no disconnect event fires. */
  async close(): Promise<void> {
    this.closed = true
    const pending = this.waiters.splice(0)
    for (const w of pending) w.reject(new EbbError('EBB connection closed'))
    await this.transport.close()
  }

  private handleDisconnect(): void {
    this.closed = true
    const pending = this.waiters.splice(0)
    for (const w of pending) w.reject(new EbbError('EBB disconnected'))
    for (const cb of this.disconnectCbs) cb()
  }

  private handleLine(line: string): void {
    const w = this.waiters[0]
    if (!w) return // stray line (e.g. boot banner) — ignore
    if (line.startsWith('!')) {
      this.waiters.shift()
      w.reject(new EbbError(line))
      return
    }
    if (w.singleLine) {
      this.waiters.shift()
      w.resolve([line])
      return
    }
    if (line === 'OK') {
      this.waiters.shift()
      w.resolve(w.lines)
      return
    }
    w.lines.push(line)
  }

  /** Send one command; resolve with its data lines (`OK` stripped). Rejects on an `!` error reply
   *  or disconnect. The returned promise settles when the EBB acknowledges — for motion commands
   *  that ack is withheld while the board's FIFO is full, which is the streaming flow control. */
  command(cmd: string): Promise<string[]> {
    if (this.closed) return Promise.reject(new EbbError('EBB disconnected'))
    const singleLine = cmd === 'V' || cmd === 'QM'
    return new Promise<string[]>((resolve, reject) => {
      this.waiters.push({ singleLine, lines: [], resolve, reject })
      this.transport.write(cmd + '\r').catch((e) => {
        // A failed write means the reply will never come; settle the waiter now.
        const i = this.waiters.findIndex((w) => w.resolve === resolve)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(e instanceof Error ? e : new EbbError(String(e)))
      })
    })
  }

  // ---- typed commands ----------------------------------------------------------------------

  /** Firmware version string, e.g. `EBBv13_and_above EB Firmware Version 2.7.0`. */
  async version(): Promise<string> {
    const lines = await this.command('V')
    return lines[0] ?? ''
  }

  /** Enable both steppers at the AxiDraw-native 16× microstepping (80 steps/mm). */
  enableMotors(): Promise<string[]> {
    return this.command('EM,1,1')
  }

  disableMotors(): Promise<string[]> {
    return this.command('EM,0,0')
  }

  /** Program the pen servo's up (SC,4 — the SP,1 target) and down (SC,5 — the SP,0 target)
   *  positions from profile percents. */
  async configureServo(upPercent: number, downPercent: number): Promise<void> {
    await this.command(`SC,4,${servoPos(upPercent)}`)
    await this.command(`SC,5,${servoPos(downPercent)}`)
  }

  /** Raise (`up = true` → SP,1) or lower the pen. `delayMs` makes the EBB hold off the next
   *  motion command for the physical move's duration. */
  setPen(up: boolean, delayMs: number): Promise<string[]> {
    const d = Math.max(1, Math.round(delayMs))
    return this.command(`SP,${up ? 1 : 0},${d}`)
  }

  /** Low-level accelerated move (firmware ≥ 2.7): per-axis LM rate/steps/accel terms from the
   *  planner. `clear` zeroes the step accumulators first (bitmask: 1 = axis1, 2 = axis2). */
  lowLevelMove(
    rate1: number,
    steps1: number,
    delta1: number,
    rate2: number,
    steps2: number,
    delta2: number,
    clear?: number,
  ): Promise<string[]> {
    const base = `LM,${rate1},${steps1},${delta1},${rate2},${steps2},${delta2}`
    return this.command(clear === undefined ? base : `${base},${clear}`)
  }

  /** Constant-rate move: `steps1`/`steps2` over `durationMs` (the pre-2.7 fallback). */
  move(durationMs: number, steps1: number, steps2: number): Promise<string[]> {
    return this.command(`SM,${Math.max(1, Math.round(durationMs))},${steps1},${steps2}`)
  }

  /** Motion status — is anything executing / moving / queued. */
  async queryMotion(): Promise<MotionStatus> {
    const [line] = await this.command('QM')
    const parts = (line ?? '').split(',')
    return {
      executing: parts[1] !== '0',
      motor1: parts[2] !== '0',
      motor2: parts[3] !== '0',
      fifo: parts[4] !== '0',
    }
  }

  /** Has the board's PRG button been pressed since the last query (latched, cleared by read)? */
  async queryButton(): Promise<boolean> {
    const lines = await this.command('QB')
    return lines[0] === '1'
  }

  /** Global step positions per motor axis (since the last CS/EM). */
  async querySteps(): Promise<[number, number]> {
    const lines = await this.command('QS')
    const parts = (lines[0] ?? '').split(',')
    return [parseInt(parts[0] ?? '0', 10) || 0, parseInt(parts[1] ?? '0', 10) || 0]
  }

  /** Zero the global step counters (+ accumulators) — "home is here". */
  clearSteps(): Promise<string[]> {
    return this.command('CS')
  }

  /** Abort the executing move and flush the motion FIFO immediately. */
  emergencyStop(): Promise<string[]> {
    return this.command('ES')
  }
}

/** LM needs firmware ≥ 2.7.0 (older boards get the SM fallback: same geometry, chunkier motion). */
export function supportsLM(version: string): boolean {
  const m = version.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return false
  const [maj, min] = [parseInt(m[1], 10), parseInt(m[2], 10)]
  return maj > 2 || (maj === 2 && min >= 7)
}
