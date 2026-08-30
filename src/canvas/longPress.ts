// Touch long-press = right-click. Touch has no secondary button, and iOS never synthesizes a
// `contextmenu` event from a long touch (Android does, which the Canvas ignores in favour of this
// one timer so the menu can't open twice). The Canvas arms the timer on a single non-mouse
// pointerdown and opens the context menu when it fires; the release that follows must then be
// inert — `longPressed` is the one-shot handshake telling the element's tap-to-toggle handler
// (useNodeInteraction) that this release was the tail of a menu gesture, not a tap.
export const LONG_PRESS_MS = 500
/** Movement past this (px) before the timer fires turns the press back into a drag. */
export const LONG_PRESS_SLOP_PX = 8
/** Haptic tick when the press fires (navigator.vibrate — Android only; iOS exposes no web haptics). */
export const LONG_PRESS_HAPTIC_MS = 15

export const longPressed = { current: false }

/** Read-and-clear: true exactly once after a long-press fired. */
export function consumeLongPress(): boolean {
  const v = longPressed.current
  longPressed.current = false
  return v
}
