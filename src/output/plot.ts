// Direct-plot transport seam. Wraps the Bridge for PrusaLink extension client (one singleton) and
// dispatches a plot job by the profile's device binding. The only transport today is `prusalink`;
// a future `webserial` (e.g. AxiDraw) adds another arm here. All extension access is consent-gated
// inside the extension; credentials never reach this code.
import { createBridge, BridgeError, type PrinterInfo, type PrinterStatus } from '@tibordp/prusalink-bridge'
import type { MachineProfile } from '../core/types'

const bridge = createBridge()

export { BridgeError }
export type { PrinterInfo, PrinterStatus }

/** Is the bridge extension installed? Harmless ping — never requests access, never throws. */
export const bridgeAvailable = (): Promise<boolean> => bridge.available()
/** Printers already granted to this origin (no prompt). */
export const grantedPrinters = (): Promise<PrinterInfo[]> => bridge.printers()
/** Open the consent prompt (must be from a user gesture). `force` re-prompts to add printers. */
export const requestPrinters = (force = false): Promise<PrinterInfo[]> => bridge.requestAccess({ force })
/** Live status of a granted printer. */
export const printerStatus = (id: string): Promise<PrinterStatus> => bridge.status(id)

/** Send a finished G-code job to the profile's bound device. Throws a {@link BridgeError} on failure. */
export async function plot(profile: MachineProfile, gcode: string, filename: string): Promise<void> {
  const d = profile.device
  if (d?.transport === 'prusalink') {
    await bridge.print(d.printerId, { name: filename, gcode })
    return
  }
  throw new BridgeError('BAD_REQUEST', 'No physical printer configured')
}
