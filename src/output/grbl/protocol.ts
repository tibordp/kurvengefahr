// The GRBL 1.1 wire protocol. One class, transport-agnostic. Two traffic kinds coexist and must
// not be confused:
//
//   • Lines: `send()` writes one \n-terminated G-code/`$` line; GRBL acks each with `ok` or
//     `error:N`, strictly in order, so response matching is a FIFO of waiters. The ack means
//     "parsed and buffered", NOT "executed" — flow control (the session) counts unacked bytes
//     against GRBL's 128-byte RX ring.
//   • Real-time bytes: `?` (status), `!` (feed hold), `~` (resume), 0x18 (soft reset) are picked
//     out of the RX stream ahead of the parser. They produce no `ok` and consume no waiter.
//
// Unsolicited lines the FIFO must ignore: `<...>` status reports (replies to `?`), `ALARM:N`
// (fatal — rejects everything pending), `[MSG:...]` feedback, `$N=...` settings dumps, and the
// welcome banner — `Grbl 1.1h [...]` or grblHAL's `GrblHAL 1.1f [...]` — printed on power-up/DTR
// reset and (usually) after 0x18; the reset and connect handshakes wait on it. "Usually": grblHAL
// observed to reset silently from a latched E-stop alarm, so callers must not treat a missing
// reset banner as a dead board (the session probes with `?` instead).
import type { LineTransport } from '../serial/transport'

export class GrblError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export type GrblState = 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep'

export interface GrblStatus {
  state: GrblState
  /** Sub-state, e.g. `Hold:0` = hold complete, `Hold:1` = still decelerating. Null if absent. */
  sub: number | null
  /** Work position, mm. Derived from `MPos − WCO` when the report carries machine coords ($10
   *  default); null until a usable report arrives. */
  wpos: { x: number; y: number; z: number } | null
}

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

interface BannerWaiter {
  resolve: (banner: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class Grbl {
  private waiters: Waiter[] = []
  private bannerWaiters: BannerWaiter[] = []
  private statusCbs: ((s: GrblStatus) => void)[] = []
  private alarmCbs: ((code: number) => void)[] = []
  private disconnectCbs: (() => void)[] = []
  /** Last seen work-coordinate offset — GRBL includes `WCO:` in a status report periodically,
   *  not every time, so it's tracked here to derive WPos from MPos reports. */
  private wco: { x: number; y: number; z: number } | null = null
  private closed = false

  constructor(private transport: LineTransport) {
    transport.onLine((line) => this.handleLine(line))
    transport.onDisconnect(() => this.handleDisconnect())
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCbs.push(cb)
  }

  onStatus(cb: (s: GrblStatus) => void): void {
    this.statusCbs.push(cb)
  }

  onAlarm(cb: (code: number) => void): void {
    this.alarmCbs.push(cb)
  }

  /** Deliberately close the connection: pending commands reject, no disconnect event fires. */
  async close(): Promise<void> {
    this.closed = true
    this.rejectAll(new GrblError('GRBL connection closed'))
    await this.transport.close()
  }

  private handleDisconnect(): void {
    this.closed = true
    this.rejectAll(new GrblError('GRBL disconnected'))
    for (const cb of this.disconnectCbs) cb()
  }

  private rejectAll(err: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(err)
    for (const b of this.bannerWaiters.splice(0)) {
      clearTimeout(b.timer)
      b.reject(err)
    }
  }

  private handleLine(line: string): void {
    if (line === 'ok') {
      this.waiters.shift()?.resolve()
      return
    }
    const err = line.match(/^error:(\d+)/)
    if (err) {
      const w = this.waiters.shift()
      w?.reject(new GrblError(line, parseInt(err[1], 10)))
      return
    }
    if (line.startsWith('<') && line.endsWith('>')) {
      const s = this.parseStatus(line)
      if (s) for (const cb of this.statusCbs) cb(s)
      return
    }
    const alarm = line.match(/^ALARM:(\d+)/)
    if (alarm) {
      const code = parseInt(alarm[1], 10)
      // Alarm kills the job: queued lines are discarded, their acks never come.
      for (const w of this.waiters.splice(0)) w.reject(new GrblError(line, code))
      for (const cb of this.alarmCbs) cb(code)
      return
    }
    if (/^Grbl(HAL)? /.test(line)) {
      for (const b of this.bannerWaiters.splice(0)) {
        clearTimeout(b.timer)
        b.resolve(line)
      }
      return
    }
    // [MSG:...], [GC:...], $N=..., startup-line echoes — informational, ignored.
  }

  /** `<Idle|MPos:1.000,2.000,3.000|FS:0,0|WCO:0.000,0.000,0.000>` → GrblStatus. */
  private parseStatus(line: string): GrblStatus | null {
    const fields = line.slice(1, -1).split('|')
    const [state, sub] = fields[0].split(':')
    if (!state) return null
    const vec = (s: string) => {
      const [x, y, z] = s.split(',').map(Number)
      return { x: x || 0, y: y || 0, z: z || 0 }
    }
    let wpos: GrblStatus['wpos'] = null
    let mpos: GrblStatus['wpos'] = null
    for (const f of fields.slice(1)) {
      if (f.startsWith('WPos:')) wpos = vec(f.slice(5))
      else if (f.startsWith('MPos:')) mpos = vec(f.slice(5))
      else if (f.startsWith('WCO:')) this.wco = vec(f.slice(4))
    }
    if (!wpos && mpos && this.wco)
      wpos = { x: mpos.x - this.wco.x, y: mpos.y - this.wco.y, z: mpos.z - this.wco.z }
    return { state: state as GrblState, sub: sub !== undefined ? parseInt(sub, 10) : null, wpos }
  }

  /** Send one line; resolves on `ok`, rejects with GrblError on `error:N`, alarm, or disconnect.
   *  Callers do their own flow control — this does not hold writes back. */
  send(line: string): Promise<void> {
    if (this.closed) return Promise.reject(new GrblError('GRBL disconnected'))
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.transport.write(line + '\n').catch((e) => {
        // A failed write means the ack will never come; settle the waiter now.
        const i = this.waiters.findIndex((w) => w.resolve === resolve)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(e instanceof Error ? e : new GrblError(String(e)))
      })
    })
  }

  // ---- real-time bytes (bypass the RX buffer and the ack FIFO) ------------------------------

  private realtime(byte: string): void {
    if (this.closed) return
    void this.transport.write(byte).catch(() => {})
  }

  /** Ask for a status report — the reply arrives as an unsolicited `<...>` line via onStatus. */
  statusQuery(): void {
    this.realtime('?')
  }

  /** Feed hold: decelerate to a stop mid-move. State goes Hold:1 → Hold:0 when complete. */
  feedHold(): void {
    this.realtime('!')
  }

  cycleResume(): void {
    this.realtime('~')
  }

  /** Soft reset (0x18): kills motion and DISCARDS the RX buffer — every pending ack is lost, so
   *  in-flight waiters reject here. Resolves with the welcome banner (rejects on timeout). */
  softReset(timeoutMs = 3000): Promise<string> {
    for (const w of this.waiters.splice(0)) w.reject(new GrblError('reset'))
    const banner = this.waitBanner(timeoutMs)
    this.realtime('\x18')
    return banner
  }

  /** Wait for the next welcome banner — the connect handshake (DTR auto-reset prints one). */
  waitBanner(timeoutMs = 3000): Promise<string> {
    if (this.closed) return Promise.reject(new GrblError('GRBL disconnected'))
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.bannerWaiters.findIndex((b) => b.resolve === resolve)
        if (i >= 0) this.bannerWaiters.splice(i, 1)
        reject(new GrblError('timed out waiting for the GRBL banner'))
      }, timeoutMs)
      this.bannerWaiters.push({ resolve, reject, timer })
    })
  }

  // ---- typed line commands -------------------------------------------------------------------

  /** Clear an alarm lock without homing ("machine position is now unknown" — fine for a
   *  park-anywhere plotter that zeroes its own work origin). */
  unlock(): Promise<void> {
    return this.send('$X')
  }

  /** Run the homing cycle. The `ok` arrives only when homing completes — can take many seconds. */
  home(): Promise<void> {
    return this.send('$H')
  }
}
