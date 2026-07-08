// A fake EBB behind the transport interface — enough behavior for session tests and hardware-free
// development: default replies per command family, scripted overrides, configurable ack delays
// (to exercise flow control), a latched PRG button, and unplug simulation. Replies are delivered
// strictly in command order regardless of per-command delays, like the real (serial) wire.
import type { EbbTransport } from './transport'

export interface MockOptions {
  /** Override replies: return the data lines (`OK` is appended automatically, QM excepted), or
   *  null/undefined to fall through to the defaults. */
  reply?: (cmd: string) => string[] | null | undefined
  /** Ack delay in ms — a number, or per-command (e.g. to make motion commands slow). */
  ackDelayMs?: number | ((cmd: string) => number)
  version?: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class MockTransport implements EbbTransport {
  /** Every command received, in order (CR-stripped) — assert against this in tests. */
  readonly sent: string[] = []
  private lineCb: (line: string) => void = () => {}
  private disconnectCb: () => void = () => {}
  private buffer = ''
  private chain: Promise<void> = Promise.resolve()
  private buttonLatched = false
  private dead = false

  constructor(private opts: MockOptions = {}) {}

  /** Latch a PRG button press — the next QB reads 1 (and clears it), like the hardware. */
  pressButton(): void {
    this.buttonLatched = true
  }

  /** Simulate the USB cable being yanked. */
  unplug(): void {
    if (this.dead) return
    this.dead = true
    this.disconnectCb()
  }

  async write(data: string): Promise<void> {
    if (this.dead) throw new Error('mock EBB unplugged')
    this.buffer += data
    const parts = this.buffer.split('\r')
    this.buffer = parts.pop() ?? ''
    for (const cmd of parts) {
      if (!cmd) continue
      this.sent.push(cmd)
      const delay =
        typeof this.opts.ackDelayMs === 'function'
          ? this.opts.ackDelayMs(cmd)
          : (this.opts.ackDelayMs ?? 0)
      // Serialize replies so a slow command's reply never overtakes a later fast one.
      this.chain = this.chain.then(async () => {
        if (delay > 0) await sleep(delay)
        if (this.dead) return
        for (const line of this.replyTo(cmd)) this.lineCb(line)
      })
    }
  }

  private replyTo(cmd: string): string[] {
    const custom = this.opts.reply?.(cmd)
    if (custom) return this.frame(cmd, custom)
    const word = cmd.split(',')[0].toUpperCase()
    switch (word) {
      case 'V': // single line, no OK (real 3.0.3 framing)
        return [this.opts.version ?? 'EBBv13_and_above EB Firmware Version 3.0.3']
      case 'QM':
        return ['QM,0,0,0,0'] // idle; no OK — QM's real framing
      case 'QB': {
        const pressed = this.buttonLatched
        this.buttonLatched = false
        return this.frame(cmd, [pressed ? '1' : '0'])
      }
      case 'QS':
        return this.frame(cmd, ['0,0'])
      case 'ES':
        return this.frame(cmd, ['0'])
      default:
        return this.frame(cmd, [])
    }
  }

  private frame(cmd: string, data: string[]): string[] {
    const word = cmd.split(',')[0].toUpperCase()
    // V/QM are single-line replies; errors carry no trailing OK (verified on 3.0.3).
    if (word === 'V' || word === 'QM' || data[0]?.startsWith('!')) return data
    return [...data, 'OK']
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
