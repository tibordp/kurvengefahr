// Shared state for the Web Serial EBB connection (AxiDraw). Mirrors the bridge store's role: the
// machine inspector renders connect/disconnect from it, and the toolbar gates the Plot button on
// the same `connected` flag. The live `Ebb` instance is module state here — it's a transport
// handle, never persisted (Web Serial grants themselves persist per-origin via `getPorts()`).
import { create } from 'zustand'
import { Ebb } from '../output/ebb/protocol'
import { isEbbPort, WebSerialTransport, webSerialSupported, EBB_USB } from '../output/ebb/transport'

let ebb: Ebb | null = null

/** The live EBB connection, or null. The plot session and the inspector's servo-test use this. */
export function currentEbb(): Ebb | null {
  return ebb
}

interface SerialStore {
  /** Does this browser support Web Serial at all? */
  supported: boolean
  connected: boolean
  /** The board's firmware banner, e.g. `EBBv13_and_above EB Firmware Version 3.0.3`. */
  version: string | null
  connecting: boolean
  /** Re-open an already-granted EBB port — no permission prompt. Idempotent. */
  probe: () => Promise<void>
  /** Ask the user to grant an EBB port (needs a user gesture), then open it. */
  connect: () => Promise<void>
  disconnect: () => Promise<void>
}

async function openPort(port: SerialPort, set: (p: Partial<SerialStore>) => void): Promise<void> {
  const transport = await WebSerialTransport.open(port)
  const next = new Ebb(transport)
  next.onDisconnect(() => {
    if (ebb === next) {
      ebb = null
      set({ connected: false, version: null })
    }
  })
  const version = await next.version()
  ebb = next
  set({ connected: true, version })
}

export const useSerial = create<SerialStore>((set, get) => ({
  supported: webSerialSupported(),
  connected: false,
  version: null,
  connecting: false,

  probe: async () => {
    const s = get()
    if (!s.supported || s.connected || s.connecting) return
    set({ connecting: true })
    try {
      const port = (await navigator.serial.getPorts()).find(isEbbPort)
      if (port) await openPort(port, set)
    } catch {
      // Port already held elsewhere (another tab?) or vanished — stay disconnected; the user can
      // hit Connect explicitly.
    } finally {
      set({ connecting: false })
    }
  },

  connect: async () => {
    const s = get()
    if (!s.supported || s.connected || s.connecting) return
    set({ connecting: true })
    try {
      const port = await navigator.serial.requestPort({ filters: [EBB_USB] })
      await openPort(port, set)
    } catch {
      // user dismissed the picker, or the port failed to open — leave state as-is
    } finally {
      set({ connecting: false })
    }
  },

  disconnect: async () => {
    const gone = ebb
    ebb = null
    set({ connected: false, version: null })
    await gone?.close()
  },
}))
