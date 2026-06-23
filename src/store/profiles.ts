// Machine-profile presets. These seed the editable document profile; nothing is locked to
// the MK4 — bed, feeds, Z heights and pre/postamble are all editable in the UI.
import type { MachineProfile } from '../core/types'

const DEFAULT_PENS = [{ id: 0, name: 'Pen 1', color: '#1a1a1a' }]

export const PRUSA_MK4: MachineProfile = {
  id: 'prusa-mk4',
  name: 'Prusa MK4 + pen holder',
  bed: { width: 250, height: 210 },
  origin: 'bottom-left',
  feeds: { travel: 9000, draw: 3000 },
  // Spring-loaded holder: Z down presses the pen; tune `down` for line weight, `dwell`
  // gives the spring time to settle. Placeholder values — dial in on the machine.
  penZ: { up: 4, down: 0, dwell: 80 },
  penOffset: { x: 0, y: 0, z: 0 },
  pens: DEFAULT_PENS,
  preamble: ['G21 ; mm', 'G90 ; absolute', 'G28 ; home'].join('\n'),
  postamble: ['G0 Z30 ; pen clear', 'G0 X0 Y0 ; park', 'M84 ; motors off'].join('\n'),
  units: 'mm',
}

export const GENERIC_A4: MachineProfile = {
  id: 'generic-a4',
  name: 'Generic A4',
  bed: { width: 297, height: 210 },
  origin: 'bottom-left',
  feeds: { travel: 6000, draw: 2000 },
  penZ: { up: 5, down: 0, dwell: 100 },
  penOffset: { x: 0, y: 0, z: 0 },
  pens: DEFAULT_PENS,
  preamble: ['G21', 'G90', 'G28'].join('\n'),
  postamble: ['G0 Z30', 'G0 X0 Y0'].join('\n'),
  units: 'mm',
}

export const PROFILE_PRESETS: MachineProfile[] = [PRUSA_MK4, GENERIC_A4]
