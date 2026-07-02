// Shared state for the browser plotting bridge (the "Bridge for PrusaLink" extension): whether it's
// installed and which printers it has granted us. Lifted out of the machine inspector so the toolbar
// can gate the Plot button on the *same* granted list (a profile can bind a printer that later
// disappears — we must block plotting, not just fail on send). Live per-printer status stays local to
// the inspector section (only polled while it's open).
import { create } from 'zustand'
import { bridgeAvailable, grantedPrinters, requestPrinters, type PrinterInfo } from '../output/plot'

interface BridgeStore {
  /** null = not probed yet; true/false = extension present or not. */
  available: boolean | null
  /** Printers the extension currently grants this app (no live status here). */
  printers: PrinterInfo[]
  connecting: boolean
  /** Detect the extension and load already-granted printers — no access prompt. Idempotent. */
  probe: () => Promise<void>
  /** Request access (may prompt the user) and reload the granted list. */
  refresh: () => Promise<void>
}

export const useBridge = create<BridgeStore>((set, get) => ({
  available: null,
  printers: [],
  connecting: false,
  probe: async () => {
    const ok = await bridgeAvailable().catch(() => false)
    const printers = ok ? await grantedPrinters().catch(() => []) : []
    set({ available: ok, printers })
  },
  refresh: async () => {
    if (get().connecting) return
    set({ connecting: true })
    try {
      set({ printers: await requestPrinters(true), available: true })
    } catch {
      // user denied / closed the prompt — leave the list as-is
    } finally {
      set({ connecting: false })
    }
  },
}))

/** Whether a bound `prusalink` printer id is currently reachable (extension present + still granted).
 *  `null` id (no binding) is not reachable — there's simply nothing to plot to. */
export function isPrinterConnected(boundId: string | null, available: boolean | null, printers: PrinterInfo[]): boolean {
  return !!boundId && available === true && printers.some((p) => p.id === boundId)
}
