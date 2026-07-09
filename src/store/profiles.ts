// Machine-profile presets. These seed the editable document profile; nothing is locked to
// a specific machine — bed, feeds, Z heights and pre/postamble are all editable in the UI. A
// profile's `kind` comes from the preset it was seeded from (there's no kind switcher).
//
// The catalog mostly varies by work area — real machines' published travel: AxiDraw per
// axidraw.com / EMSL's axidraw_conf.py, iDraw per uunatek.com (EBB-compatible boards → axidraw
// kind), EleksDraw per the EleksMaker wiki, Prusa beds per prusa3d specs. Motion/servo/feed
// defaults are the family's, not per-machine — dial in on the hardware.
import type { AxidrawProfile, GrblProfile, MachineProfile, PrusaProfile } from '../core/types'

const DEFAULT_PENS = [{ id: 0, name: 'Pen 1', color: '#1a1a1a' }]

/** Presets are grouped by kind in the profile picker, under these labels. */
export const PRESET_GROUP_LABELS: Record<MachineProfile['kind'], string> = {
  prusa: 'G-code printers',
  axidraw: 'EBB plotters',
  grbl: 'GRBL plotters',
}

export const PRUSA_MK4: PrusaProfile = {
  id: 'prusa-mk4',
  name: 'Prusa MK4',
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
  name: 'Generic G-code (A4)',
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

/** A Prusa-family variant off the generic G-code base: the differences are bed size and, for the
 *  MK4 family, the input-shaper preamble (kept only where the firmware supports it). */
const prusaVariant = (id: string, name: string, width: number, height: number): PrusaProfile => ({
  ...structuredClone(GENERIC_A4),
  id,
  name,
  bed: { width, height },
})

const PRUSA_MINI = prusaVariant('prusa-mini', 'Prusa MINI+', 180, 180)
const PRUSA_MK3S = prusaVariant('prusa-mk3s', 'Prusa MK3S+', 250, 210)
const PRUSA_CORE_ONE = prusaVariant('prusa-core-one', 'Prusa CORE One', 250, 220)
const PRUSA_XL = prusaVariant('prusa-xl', 'Prusa XL', 360, 360)

// AxiDraw motion/servo defaults follow saxi's; speeds are conservative for a first pen.
// `cornering` is junction deviation in mm (lower = truer corners, slower plots).
export const AXIDRAW_V3: AxidrawProfile = {
  id: 'axidraw-v3',
  name: 'AxiDraw V3 · SE/A4',
  kind: 'axidraw',
  bed: { width: 300, height: 218 },
  origin: 'top-left',
  motion: { drawSpeed: 25, travelSpeed: 100, acceleration: 300, cornering: 0.127 },
  servo: { upPercent: 60, downPercent: 30, liftMs: 180, dropMs: 180 },
  pens: DEFAULT_PENS,
  units: 'mm',
}

/** An AxiDraw-family variant: same motion/servo defaults, different travel. */
const axidrawVariant = (id: string, name: string, width: number, height: number): AxidrawProfile => ({
  ...structuredClone(AXIDRAW_V3),
  id,
  name,
  bed: { width, height },
})

export const AXIDRAW_V3_A3 = axidrawVariant('axidraw-v3-a3', 'AxiDraw V3/A3 · SE/A3', 430, 297)
const AXIDRAW_XLX = axidrawVariant('axidraw-v3-xlx', 'AxiDraw V3 XLX', 595, 218)
const AXIDRAW_SE_A2 = axidrawVariant('axidraw-se-a2', 'AxiDraw SE/A2', 594, 432)
const AXIDRAW_SE_A1 = axidrawVariant('axidraw-se-a1', 'AxiDraw SE/A1', 864, 594)
const AXIDRAW_MINIKIT = axidrawVariant('axidraw-minikit', 'AxiDraw MiniKit', 160, 102)
// UUNA TEK iDraw machines run EBB-compatible boards (DrawCore) — same protocol, same profile kind.
const IDRAW_A4 = axidrawVariant('idraw-2-a4', 'iDraw 2.0 (A4)', 300, 210)
const IDRAW_H_A3 = axidrawVariant('idraw-h-a3', 'iDraw H (A3)', 420, 300)

// Servo S values and settle times are placeholders — grbl-servo forks map S to pulse width in
// wildly different ways; the inspector's pen test is how you dial them in.
export const GRBL_PLOTTER: GrblProfile = {
  id: 'grbl-plotter',
  name: 'Generic GRBL plotter',
  kind: 'grbl',
  bed: { width: 297, height: 210 },
  origin: 'bottom-left',
  baudRate: 115200,
  feeds: { travel: 4000, draw: 1500 },
  pen: { mode: 'servo', upS: 750, downS: 250, raiseMs: 300, lowerMs: 300 },
  homing: false,
  pens: DEFAULT_PENS,
  preamble: '',
  postamble: '',
  pause: 'M0 ; {message}',
  units: 'mm',
}

/** A GRBL-family variant: same servo/feed defaults, different work area. */
const grblVariant = (id: string, name: string, width: number, height: number): GrblProfile => ({
  ...structuredClone(GRBL_PLOTTER),
  id,
  name,
  bed: { width, height },
})

// Servo-pen GRBL kits; both typically run robottini-style grbl-servo forks, where the M3 S scale
// varies by build — the pen-test button is the dial-in tool.
const ELEKSDRAW = grblVariant('eleksdraw', 'EleksDraw', 280, 200)
const FOURXIDRAW = grblVariant('4xidraw', '4xiDraw (A4)', 300, 218)

/** The preset catalog, ordered as the picker lists it (grouped by kind, this order within). */
export const PROFILE_PRESETS: MachineProfile[] = [
  PRUSA_MK4,
  PRUSA_MK3S,
  PRUSA_MINI,
  PRUSA_CORE_ONE,
  PRUSA_XL,
  GENERIC_A4,
  AXIDRAW_V3,
  AXIDRAW_V3_A3,
  AXIDRAW_XLX,
  AXIDRAW_SE_A2,
  AXIDRAW_SE_A1,
  AXIDRAW_MINIKIT,
  IDRAW_A4,
  IDRAW_H_A3,
  GRBL_PLOTTER,
  ELEKSDRAW,
  FOURXIDRAW,
]

/** Built-in presets differ from custom profiles only in that they can't be deleted or renamed. */
export function isBuiltinProfile(id: string): boolean {
  return PROFILE_PRESETS.some((p) => p.id === id)
}

export function findBuiltinProfile(id: string): MachineProfile | undefined {
  return PROFILE_PRESETS.find((p) => p.id === id)
}
