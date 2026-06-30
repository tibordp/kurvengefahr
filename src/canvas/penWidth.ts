// Display pen width (mm) for the canvas + preview. Pressure is shown as line weight, so the two
// agree on how a stroke's pressure reads on screen. This is *display only* — the machine maps
// pressure to a pen-down Z (see `emit`), not to a width.

/** Nominal pen-tip width (mm) at full pressure. */
export const PEN_WIDTH_MM = 0.4

/** On-screen stroke width (mm) for a pressure 0..1. When the profile has pressure off, every stroke
 *  renders at the full nominal width (`enabled=false`). Light strokes keep a visible floor so they
 *  don't vanish at low pressure. */
export function displayPenWidthMm(pressure: number, enabled: boolean): number {
  if (!enabled) return PEN_WIDTH_MM
  const p = Math.min(1, Math.max(0, pressure))
  return PEN_WIDTH_MM * (0.2 + 0.8 * p)
}
