// A fake GRBL 1.1 board behind the transport interface — enough behavior for session tests and
// hardware-free development. Faithful where the session depends on it:
//   • real-time bytes (`?` `!` `~` 0x18) are picked out of the byte stream, not line-framed, and
//     act immediately — `?` answers with a status report even while line acks are delayed;
//   • line acks are serialized in order with configurable delays (to exercise flow control);
//   • 0x18 discards everything unacked (their `ok`s never come) and prints the welcome banner;
//   • state: Run while lines are in flight, Hold after `!` (first report is already Hold:0 —
//     deceleration is instant here), Alarm after `injectAlarm` until `$X`/`$H`;
//   • position: WPos tracks the last *acked* motion target (ack = executed in mock-land, a
//     deliberate simplification of GRBL's ack-means-buffered).
import type { LineTransport } from '../serial/transport'

export interface MockGrblOptions {
  /** Override replies: return the full reply lines (including the `ok`), or null/undefined to
   *  fall through to the defaults. */
  reply?: (line: string) => string[] | null | undefined
  /** Ack delay in ms — a number, or per-line (e.g. to make motion lines slow). */
  ackDelayMs?: number | ((line: string) => number)
  /** Report `MPos:` (+ periodic `WCO:`) instead of `WPos:` — exercises the $10 default. */
  reportMPos?: boolean
  banner?: string
  /** grblHAL quirk: a board latched in an E-stop alarm resets silently — no welcome banner after
   *  0x18 (observed on a BlackPill running grblHAL 1.1f). Default true (vanilla behavior). */
  bannerOnReset?: boolean
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class MockGrbl implements LineTransport {
  /** Every line received, in order (terminator-stripped) — assert against this in tests. */
  readonly sent: string[] = []
  /** High-water mark of unacked line bytes (incl. terminators) — the flow-control invariant. */
  maxUnackedBytes = 0

  private lineCb: (line: string) => void = () => {}
  private disconnectCb: () => void = () => {}
  private buffer = ''
  private chain: Promise<void> = Promise.resolve()
  private generation = 0
  private unackedBytes = 0
  private inFlight = 0
  private held = false
  private alarmed = false
  private wpos = { x: 0, y: 0, z: 0 }
  private statusReports = 0
  private dead = false

  constructor(private opts: MockGrblOptions = {}) {}

  /** Print the welcome banner, as the DTR auto-reset does when the port opens. */
  boot(): void {
    setTimeout(() => {
      if (!this.dead) this.lineCb(this.opts.banner ?? "Grbl 1.1h ['$' for help]")
    }, 1)
  }

  /** Raise an asynchronous alarm (e.g. hard limit) — emits `ALARM:n` and locks the machine. */
  injectAlarm(code: number): void {
    this.alarmed = true
    this.lineCb(`ALARM:${code}`)
  }

  /** Simulate the USB cable being yanked. */
  unplug(): void {
    if (this.dead) return
    this.dead = true
    this.disconnectCb()
  }

  async write(data: string): Promise<void> {
    if (this.dead) throw new Error('mock GRBL unplugged')
    for (const ch of data) {
      // Real-time characters act immediately, wherever they land in the stream.
      if (ch === '?') this.emitStatus()
      else if (ch === '!') this.held = true
      else if (ch === '~') this.held = false
      else if (ch === '\x18') this.reset()
      else if (ch === '\n' || ch === '\r') {
        const line = this.buffer
        this.buffer = ''
        if (line) this.enqueue(line)
      } else this.buffer += ch
    }
  }

  private enqueue(line: string): void {
    this.sent.push(line)
    this.unackedBytes += line.length + 1
    this.maxUnackedBytes = Math.max(this.maxUnackedBytes, this.unackedBytes)
    this.inFlight++
    const gen = this.generation
    const delay = typeof this.opts.ackDelayMs === 'function' ? this.opts.ackDelayMs(line) : (this.opts.ackDelayMs ?? 0)
    // Serialize replies so a slow line's ack never overtakes a later fast one.
    this.chain = this.chain.then(async () => {
      if (delay > 0) await sleep(delay)
      if (this.dead || gen !== this.generation) return // reset discarded this line
      while (this.held && !this.dead && gen === this.generation) await sleep(2) // feed hold: nothing completes
      if (this.dead || gen !== this.generation) return
      this.unackedBytes -= line.length + 1
      this.inFlight--
      this.trackPosition(line)
      for (const reply of this.replyTo(line)) this.lineCb(reply)
    })
  }

  private trackPosition(line: string): void {
    if (!/^G[01]\b/.test(line)) return
    const axis = (name: string) => {
      const m = line.match(new RegExp(`${name}(-?[\\d.]+)`))
      return m ? parseFloat(m[1]) : undefined
    }
    this.wpos = { x: axis('X') ?? this.wpos.x, y: axis('Y') ?? this.wpos.y, z: axis('Z') ?? this.wpos.z }
  }

  private replyTo(line: string): string[] {
    const custom = this.opts.reply?.(line)
    if (custom) return custom
    if (line === '$X') {
      this.alarmed = false
      return ['[MSG:Caution: Unlocked]', 'ok']
    }
    if (line === '$H') {
      this.alarmed = false
      this.wpos = { x: 0, y: 0, z: 0 }
      return ['ok']
    }
    return ['ok']
  }

  private emitStatus(): void {
    const state = this.alarmed ? 'Alarm' : this.held ? 'Hold:0' : this.inFlight > 0 ? 'Run' : 'Idle'
    const p = this.wpos
    const v = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`
    // With MPos reporting, GRBL includes WCO only periodically — every 3rd report here.
    const pos = this.opts.reportMPos
      ? `MPos:${v}${this.statusReports % 3 === 0 ? '|WCO:0.000,0.000,0.000' : ''}`
      : `WPos:${v}`
    this.statusReports++
    setTimeout(() => {
      if (!this.dead) this.lineCb(`<${state}|${pos}|FS:0,0>`)
    }, 0)
  }

  private reset(): void {
    this.generation++ // pending acks are discarded
    this.unackedBytes = 0
    this.inFlight = 0
    this.held = false
    this.buffer = ''
    if (this.opts.bannerOnReset !== false) this.boot()
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb
  }

  async close(): Promise<void> {
    this.dead = true
  }
}
