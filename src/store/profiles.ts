// Machine-profile presets. These seed the editable document profile; nothing is locked to
// the MK4 — bed, feeds, Z heights and pre/postamble are all editable in the UI. A profile's
// `kind` comes from the preset it was seeded from (there's no kind switcher).
import type { AxidrawProfile, MachineProfile, PrusaProfile } from '../core/types'

const DEFAULT_PENS = [{ id: 0, name: 'Pen 1', color: '#1a1a1a' }]

export const PRUSA_MK4: PrusaProfile = {
  id: 'prusa-mk4',
  name: 'Prusa MK4 + pen holder',
  kind: 'prusa',
  bed: { width: 250, height: 210 },
  origin: 'bottom-left',
  feeds: { travel: 9000, draw: 3000 },
  // Spring-loaded holder: Z down presses the pen; tune `down` for line weight. `down` is full
  // pressure, `downLight` the lightest touch (pressure lifts toward up). Placeholders — dial in.
  penZ: { up: 4, down: 0, downLight: 2 },
  penOffset: { x: 0, y: 0, z: 0 },
  pens: DEFAULT_PENS,
  preamble: ['M862.6 P "Input shaper" ; FW feature check', 'G21 ; mm', 'G90 ; absolute', 'G28 ; home'].join('\n'),
  postamble: ['G0 Z30 ; pen clear', 'G0 X0 Y0 ; park', 'M84 ; motors off'].join('\n'),
  pause: ['G4 P500', 'M0 {message}'].join('\n'),
  units: 'mm',
}

export const GENERIC_A4: PrusaProfile = {
  id: 'generic-a4',
  name: 'Generic A4',
  kind: 'prusa',
  bed: { width: 297, height: 210 },
  origin: 'bottom-left',
  feeds: { travel: 6000, draw: 2000 },
  penZ: { up: 5, down: 0, downLight: 2.5 },
  penOffset: { x: 0, y: 0, z: 0 },
  pens: DEFAULT_PENS,
  preamble: ['G21', 'G90', 'G28'].join('\n'),
  postamble: ['G0 Z30', 'G0 X0 Y0'].join('\n'),
  pause: ['G4 P500', 'M0 {message}'].join('\n'),
  units: 'mm',
}

// AxiDraw motion/servo defaults follow saxi's; speeds are conservative for a first pen.
// `cornering` is junction deviation in mm (lower = truer corners, slower plots).
export const AXIDRAW_V3: AxidrawProfile = {
  id: 'axidraw-v3',
  name: 'AxiDraw V3',
  kind: 'axidraw',
  bed: { width: 300, height: 218 },
  origin: 'top-left',
  motion: { drawSpeed: 25, travelSpeed: 100, acceleration: 300, cornering: 0.127 },
  servo: { upPercent: 60, downPercent: 30, liftMs: 180, dropMs: 180 },
  pens: DEFAULT_PENS,
  units: 'mm',
}

export const AXIDRAW_V3_A3: AxidrawProfile = {
  ...structuredClone(AXIDRAW_V3),
  id: 'axidraw-v3-a3',
  name: 'AxiDraw V3/A3',
  bed: { width: 430, height: 297 },
}

export const PROFILE_PRESETS: MachineProfile[] = [PRUSA_MK4, GENERIC_A4, AXIDRAW_V3, AXIDRAW_V3_A3]

/** Built-in presets differ from custom profiles only in that they can't be deleted or renamed. */
export function isBuiltinProfile(id: string): boolean {
  return PROFILE_PRESETS.some((p) => p.id === id)
}

export function findBuiltinProfile(id: string): MachineProfile | undefined {
  return PROFILE_PRESETS.find((p) => p.id === id)
}
