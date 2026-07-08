// Byte transport under the EBB protocol: a line-oriented duplex channel. `WebSerialTransport`
// wraps a granted Web Serial port; `MockTransport` (mock.ts) fakes an EBB for tests and
// hardware-free development. The protocol layer (`Ebb`) is transport-agnostic.

/** The EBB's USB identity (Microchip VID, EiBotBoard PID) — the Web Serial request filter. */
export const EBB_USB = { usbVendorId: 0x04d8, usbProductId: 0xfd92 }

export interface EbbTransport {
  /** Write raw bytes (a CR-terminated command). Writes are ordered. */
  write(data: string): Promise<void>
  /** Register the single line consumer. Lines are delivered CR/LF-stripped, non-empty. */
  onLine(cb: (line: string) => void): void
  /** Register the disconnect consumer (unplug, or a fatal read/write error). Fires once. */
  onDisconnect(cb: () => void): void
  close(): Promise<void>
}

export function webSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator
}

/** Is this granted port an EBB (by USB id)? Grants persist across sessions via `getPorts()`. */
export function isEbbPort(port: SerialPort): boolean {
  const info = port.getInfo()
  return info.usbVendorId === EBB_USB.usbVendorId && info.usbProductId === EBB_USB.usbProductId
}

/** A line-splitting transport over an **already granted** `SerialPort` (callers do the
 *  `requestPort`/`getPorts` dance — that needs a user gesture and belongs to the store). */
export class WebSerialTransport implements EbbTransport {
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private encoder = new TextEncoder()
  private lineCb: (line: string) => void = () => {}
  private disconnectCb: () => void = () => {}
  private disconnected = false
  private closing = false

  private constructor(private port: SerialPort) {}

  /** Open the port and start the read loop. The EBB is USB CDC — the baud rate is ignored, but
   *  Web Serial requires one. */
  static async open(port: SerialPort): Promise<WebSerialTransport> {
    await port.open({ baudRate: 9600 })
    const t = new WebSerialTransport(port)
    t.writer = port.writable!.getWriter()
    port.addEventListener('disconnect', () => t.fireDisconnect())
    void t.readLoop()
    return t
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (this.port.readable && !this.closing) {
        const reader = this.port.readable.getReader()
        this.reader = reader
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            // Tolerant framing: the EBB's legacy replies mix <CR><NL> and <NL><CR> orders per
            // command, so split on any run of terminators and drop empties.
            const parts = buffer.split(/[\r\n]+/)
            buffer = parts.pop() ?? ''
            for (const line of parts) {
              if (line) this.lineCb(line)
            }
          }
        } finally {
          reader.releaseLock()
        }
      }
    } catch {
      // Fatal read error (device unplugged mid-read) — treated as a disconnect below.
    }
    if (!this.closing) this.fireDisconnect()
  }

  private fireDisconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.disconnectCb()
  }

  async write(data: string): Promise<void> {
    if (!this.writer) throw new Error('serial port not open')
    await this.writer.write(this.encoder.encode(data))
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb
  }

  async close(): Promise<void> {
    this.closing = true
    // Cancelling the reader resolves the pending read() as done, which lets the read loop
    // release its stream lock — a locked readable would make port.close() throw.
    try {
      await this.reader?.cancel()
    } catch {
      /* the stream may already be errored — closing is best-effort */
    }
    try {
      await this.writer?.close()
    } catch {
      /* ditto */
    }
    this.writer = null
    try {
      await this.port.close()
    } catch {
      /* ditto */
    }
  }
}
