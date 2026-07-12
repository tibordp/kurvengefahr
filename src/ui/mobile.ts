// The app's single mobile/desktop boundary: Tailwind's `md` breakpoint — the same threshold the
// inspector drawer and every `md:` class in the chrome use. JS checks go through here so they
// can't drift from the CSS.
import { useEffect, useState } from 'react'

const DESKTOP = '(min-width: 768px)'

/** Non-reactive check, for event handlers. */
export const isMobileViewport = () => !window.matchMedia(DESKTOP).matches

/** Reactive variant, for render-time branching. */
export function useIsMobile() {
  const [mobile, setMobile] = useState(isMobileViewport)
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP)
    const onChange = () => setMobile(!mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}
