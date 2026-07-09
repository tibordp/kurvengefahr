// A LineTransport over a Node fs char device — the live-hardware test suites' stand-in for Web
// Serial (EBB_DEVICE / GRBL_DEVICE). Not imported by app code.
import { execSync } from 'node:child_process'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { LineTransport } from './transport'

export class NodeSerialTransport implements LineTransport {
  private lineCb: (line: string) => void = () => {}
  private disconnectCb: () => void = () => {}
  private closed = false

  private constructor(private fh: FileHandle) {}

  /** `baudRate` matters for real UARTs (GRBL boards); USB CDC (the EBB) ignores it. */
  static async open(device: string, baudRate?: number): Promise<NodeSerialTransport> {
    // Raw mode: no echo / newline translation from the tty layer.
    execSync(`stty -f ${device} raw${baudRate ? ` ${baudRate}` : ''}`)
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
