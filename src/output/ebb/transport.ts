// The EBB's Web Serial identity. The transport itself is shared (../serial/transport) — unlike
// GRBL boards (a zoo of CH340/FTDI/Arduino bridges), the EBB has a fixed USB id, so its ports can
// be filtered and re-opened without asking.

/** The EBB's USB identity (Microchip VID, EiBotBoard PID) — the Web Serial request filter. */
export const EBB_USB = { usbVendorId: 0x04d8, usbProductId: 0xfd92 }

/** Is this granted port an EBB (by USB id)? Grants persist across sessions via `getPorts()`. */
export function isEbbPort(port: SerialPort): boolean {
  const info = port.getInfo()
  return info.usbVendorId === EBB_USB.usbVendorId && info.usbProductId === EBB_USB.usbProductId
}
