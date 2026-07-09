// Shared state for the Web Serial machine connection (AxiDraw/EBB or GRBL — one at a time, like
// the physical port). The machine inspector renders connect/disconnect from it, and the toolbar
// gates the Plot button on the same `connected` flag. The live protocol instance is module state
// here — it's a transport handle, never persisted (Web Serial grants themselves persist
// per-origin via `getPorts()`).
//
// Port identification differs by kind: the EBB has a fixed USB id (filterable, probe-able); GRBL
// boards hide behind a zoo of CH340/FTDI/Arduino bridges, so the picker is unfiltered and the
// handshake — wait for the `Grbl 1.1x` banner the DTR auto-reset prints, poke with a soft reset
// if it doesn't come (no-DTR adapters) — is what tells a GRBL board from everything else.
import { create } from 'zustand'
import { Ebb } from '../output/ebb/protocol'
import { EBB_USB, isEbbPort } from '../output/ebb/transport'
import { Grbl } from '../output/grbl/protocol'
import { WebSerialTransport, webSerialSupported } from '../output/serial/transport'
import { toast } from './toast'

export type SerialKind = 'axidraw' | 'grbl'

type Device = { kind: 'axidraw'; ebb: Ebb } | { kind: 'grbl'; grbl: Grbl }

let device: Device | null = null

/** The live EBB connection, or null. The plot session and the inspector's servo-test use this. */
export function currentEbb(): Ebb | null {
  return device?.kind === 'axidraw' ? device.ebb : null
}

/** The live GRBL connection, or null. The plot session and the inspector's pen-test use this. */
export function currentGrbl(): Grbl | null {
  return device?.kind === 'grbl' ? device.grbl : null
}

interface SerialStore {
  /** Does this browser support Web Serial at all? */
  supported: boolean
  connected: boolean
  /** The board's firmware banner, e.g. `EBBv13… Version 3.0.3` or `Grbl 1.1h ['$' for help]`. */
  version: string | null
  connecting: boolean
  /** Re-open an already-granted port of this kind — no permission prompt. Idempotent. */
  probe: (kind: SerialKind, baudRate?: number) => Promise<void>
  /** Ask the user to grant a port (needs a user gesture), then open it. */
  connect: (kind: SerialKind, baudRate?: number) => Promise<void>
  disconnect: () => Promise<void>
}

async function openPort(
  kind: SerialKind,
  port: SerialPort,
  baudRate: number | undefined,
  set: (p: Partial<SerialStore>) => void,
): Promise<void> {
  if (kind === 'axidraw') {
    // The EBB is USB CDC — the baud is ignored, but Web Serial requires one.
    const transport = await WebSerialTransport.open(port, 9600)
    const next = new Ebb(transport)
    next.onDisconnect(() => {
      if (device?.kind === 'axidraw' && device.ebb === next) {
        device = null
        set({ connected: false, version: null })
      }
    })
    const version = await next.version()
    device = { kind, ebb: next }
    set({ connected: true, version })
    return
  }
  const transport = await WebSerialTransport.open(port, baudRate ?? 115200)
  const next = new Grbl(transport)
  next.onDisconnect(() => {
    if (device?.kind === 'grbl' && device.grbl === next) {
      device = null
      set({ connected: false, version: null })
    }
  })
  // Identity handshake: opening the port toggles DTR, which resets most boards → banner. A no-DTR
  // adapter (or a board that was already up) stays silent; a soft reset provokes the banner then.
  let banner: string
  try {
    banner = await next.waitBanner(2500)
  } catch {
    try {
      banner = await next.softReset(2500)
    } catch {
      await next.close()
      toast.error("No GRBL banner from that port — doesn't look like a GRBL board (check the baud rate).")
      return
    }
  }
  device = { kind, grbl: next }
  set({ connected: true, version: banner })
}

export const useSerial = create<SerialStore>((set, get) => ({
  supported: webSerialSupported(),
  connected: false,
  version: null,
  connecting: false,

  probe: async (kind, baudRate) => {
    const s = get()
    if (!s.supported || s.connected || s.connecting) return
    set({ connecting: true })
    try {
      // The EBB is identified by USB id. For GRBL any granted non-EBB port is a candidate — with
      // several grants the first one wins; an explicit Connect resolves any ambiguity.
      const ports = await navigator.serial.getPorts()
      const port = kind === 'axidraw' ? ports.find(isEbbPort) : ports.find((p) => !isEbbPort(p))
      if (port) await openPort(kind, port, baudRate, set)
    } catch {
      // Port already held elsewhere (another tab?) or vanished — stay disconnected; the user can
      // hit Connect explicitly.
    } finally {
      set({ connecting: false })
    }
  },

  connect: async (kind, baudRate) => {
    const s = get()
    if (!s.supported || s.connected || s.connecting) return
    set({ connecting: true })
    try {
      // GRBL boards have no reliable USB identity — show every port.
      const port = await navigator.serial.requestPort(kind === 'axidraw' ? { filters: [EBB_USB] } : {})
      await openPort(kind, port, baudRate, set)
    } catch {
      // user dismissed the picker, or the port failed to open — leave state as-is
    } finally {
      set({ connecting: false })
    }
  },

  disconnect: async () => {
    const gone = device
    device = null
    set({ connected: false, version: null })
    if (gone?.kind === 'axidraw') await gone.ebb.close()
    else if (gone?.kind === 'grbl') await gone.grbl.close()
  },
}))
