// The streaming plot session for HP-GL devices: writes a GrblTape as HP-GL, one command per
// segment. The device reports nothing back — no acks, no position — so this is send-only:
//   • Flow control is the device's: XON/XOFF bytes gate every write here (RTS/CTS, when chosen,
//     is the OS's job and needs nothing from us). With no flow control at all, the OS buffers
//     the whole job and the device must keep up.
//   • Progress is what has been *sent*; the pen trails it by the device's buffer.
//   • Pause stops sending at the next stroke start; the device finishes its buffer first.
//   • Operator prompts (fiducial / pen swap) likewise appear once the commands before them are
//     sent, not when the pen gets there — the prompt copy tells the operator to wait.
//   • Cancel stops sending and appends pen-up + walk home (to the job's start), which run after
//     the buffer drains.
import { SEG } from '../../core/pipeline/planTypes'
import type { GrblTape } from '../../core/pipeline/grblTape'
import {
  hpglHomeCommand,
  hpglInitCommands,
  hpglSegmentCommand,
  newHpglCtx,
  type HpglCtx,
} from '../../core/pipeline/emitHpgl'
import type { HpglProfile } from '../../core/types'
import type { PlotDriver, SessionHooks } from '../session'

/** What the session needs from the port — `WebSerialTransport` fits. */
export interface HpglLink {
  write(data: string): Promise<void>
  onFlow(cb: (xon: boolean) => void): void
  onDisconnect(cb: () => void): void
}

export class HpglRun implements PlotDriver {
  private pauseFlag = false
  private cancelFlag = false
  private xoff = false
  private fatal: Error | null = null
  private wake: (() => void) | null = null
  private ctx: HpglCtx

  constructor(
    private tape: GrblTape,
    private link: HpglLink,
    private profile: HpglProfile,
    private hooks: SessionHooks,
  ) {
    this.ctx = newHpglCtx(profile)
    link.onFlow((xon) => {
      this.xoff = !xon
      this.wake?.()
    })
    link.onDisconnect(() => {
      this.fatal ??= new Error('plotter disconnected')
      this.wake?.()
    })
  }

  requestPause(): void {
    this.pauseFlag = true
  }

  requestResume(): void {
    this.pauseFlag = false
    this.wake?.()
  }

  requestCancel(): void {
    this.cancelFlag = true
    this.wake?.()
  }

  async run(): Promise<'done' | 'cancelled'> {
    const { tape, hooks } = this
    if (tape.length === 0) return 'done'
    await this.send(hpglInitCommands(this.profile).join(''))
    for (let i = 0; i < tape.length && !this.cancelFlag; i++) {
      if (this.pauseFlag && tape.blockStart[i]) {
        hooks.onPaused()
        await this.until(() => !this.pauseFlag || this.cancelFlag)
        if (this.cancelFlag) break
        hooks.onResumed()
      }
      const kind = tape.kind[i]
      if (kind === SEG.pauseFiducial || kind === SEG.pausePenswap) {
        const go = await hooks.prompt(kind === SEG.pauseFiducial ? 'fiducial' : 'penSwap', tape.pen[i])
        if (!go) this.cancelFlag = true
        continue
      }
      const cmd = hpglSegmentCommand(tape, i, this.ctx)
      if (cmd) await this.send(cmd)
      hooks.onProgress(i)
    }
    if (!this.cancelFlag) return 'done'
    await this.send(hpglHomeCommand(this.ctx))
    return 'cancelled'
  }

  private async send(data: string): Promise<void> {
    await this.until(() => !this.xoff)
    await this.link.write(data)
  }

  /** Resolve once `ready()` holds; every flag change wakes the check. Throws on disconnect. */
  private async until(ready: () => boolean): Promise<void> {
    for (;;) {
      if (this.fatal) throw this.fatal
      if (ready()) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}
