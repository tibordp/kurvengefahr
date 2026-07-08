// Playback state for the toolpath preview overlay. Separate from the document store: it's
// transient UI state (is the overlay open, where's the playhead, is it playing) and shouldn't
// entangle with the authoritative document.
import { create } from 'zustand'
import type { Toolpath } from '../core/preview/toolpath'

interface PreviewStore {
  active: boolean
  /** Driven mode: a live plot session owns the playhead — no scrubber/play controls, `dist` is
   *  written from the machine's acknowledged progress instead of the animation loop. */
  driven: boolean
  toolpath: Toolpath | null
  /** Playhead distance along the path, mm. */
  dist: number
  playing: boolean
  /** Path speed in mm/s (× the speed multiplier from the controls). */
  speed: number

  enter: (toolpath: Toolpath) => void
  /** Enter as a live plot overlay (see `driven`). */
  enterDriven: (toolpath: Toolpath) => void
  exit: () => void
  setDist: (d: number) => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void
}

export const usePreview = create<PreviewStore>((set) => ({
  active: false,
  driven: false,
  toolpath: null,
  dist: 0,
  playing: false,
  speed: 120,

  enter: (toolpath) => set({ active: true, driven: false, toolpath, dist: 0, playing: true }),
  enterDriven: (toolpath) => set({ active: true, driven: true, toolpath, dist: 0, playing: false }),
  exit: () => set({ active: false, driven: false, playing: false }),
  setDist: (d) => set({ dist: d }),
  setPlaying: (p) => set({ playing: p }),
  setSpeed: (s) => set({ speed: s }),
}))
