// Bundled example programs, surfaced by the inspector's "Insert example" select. Each shows off a
// different corner of the dialect: params + arcs (the default flower), recursion (tree), pressure
// modulation (spiral), setpen multi-colour (rosette), seeded randomness (wander). Keep them short
// enough to read in the dock without scrolling.
import { DEFAULT_LOGO_SOURCE } from './index'

export interface LogoExample {
  name: string
  source: string
}

export const LOGO_EXAMPLES: LogoExample[] = [
  { name: 'Flower (params, arcs)', source: DEFAULT_LOGO_SOURCE },
  {
    name: 'Fractal tree (recursion)',
    source: `; A binary fractal tree -- recursion with a depth knob.
param "depth 7 [2 9]
param "size 40 [15 80]

to tree :len :d
  if :d = 0 [stop]
  fd :len
  lt 25
  tree :len * 0.72 :d - 1
  rt 50
  tree :len * 0.72 :d - 1
  lt 25
  bk :len
end

tree :size :depth
`,
  },
  {
    name: 'Pressure spiral',
    source: `; An opening spiral that presses harder as it grows --
; per-point pressure plots as pen force (and shows as line weight).
param "turns 8 [2 16]
param "step 1.6 [0.5 4]

for [i 0 :turns * 36] [
  setpressure 0.1 + 0.9 * :i / (:turns * 36)
  fd :step * :i / 36
  rt 10
]
`,
  },
  {
    name: 'Two-pen rosette (setpen)',
    source: `; Overlapping circles alternating between pens 0 and 1 --
; the plot pauses for a pen swap between colours.
param "count 18 [4 48]
param "radius 16 [5 40]

repeat :count [
  setpen modulo repcount 2
  arc2 360 :radius
  rt 360 / :count
]
`,
  },
  {
    name: 'Random wander (seed)',
    source: `; A seeded random walk -- re-roll the seed for a new path.
param "steps 200 [20 800]

repeat :steps [
  fd 2 + random 6
  rt -60 + random 121
]
`,
  },
]
