// The `generative` element: parametric pattern generators (one element, a `kind` selector), all laid
// out by Rust and fit to a width×height box. Synchronous, like the other shapes; deterministic per
// seed. Resize bakes into width/height via applyScale (crisp re-generation).
import { registerElement } from '../registry'
import { generativeGeometry } from '../../core/wasm/shapes'
import type { Geometry } from '../../core/types'

export type GenKind = 'spirograph' | 'lsystem' | 'truchet' | 'voronoi' | 'flow'

export interface GenerativeParams {
  kind: GenKind
  seed: number
  width: number
  height: number
  // spirograph
  outerR: number
  innerR: number
  penOffset: number
  // l-system
  preset: string
  iterations: number
  angle: number
  // truchet
  cell: number
  style: string
  // voronoi
  points: number
  // flow
  spacing: number
  steps: number
  noiseScale: number
}

export const GEN_KINDS: { key: GenKind; name: string }[] = [
  { key: 'spirograph', name: 'Spirograph' },
  { key: 'lsystem', name: 'L-system' },
  { key: 'truchet', name: 'Truchet tiles' },
  { key: 'voronoi', name: 'Voronoi' },
  { key: 'flow', name: 'Flow field' },
]

export const LSYSTEM_PRESETS = ['koch', 'dragon', 'sierpinski', 'plant', 'hilbert']

/** Methods that use a random seed (so the inspector offers a re-roll). */
export const SEEDED_KINDS: ReadonlySet<GenKind> = new Set(['truchet', 'voronoi', 'flow'])

export const defaultGenerativeParams = (): GenerativeParams => ({
  kind: 'spirograph',
  seed: 1,
  width: 120,
  height: 120,
  outerR: 50,
  innerR: 30,
  penOffset: 18,
  preset: 'koch',
  iterations: 4,
  angle: 0,
  cell: 12,
  style: 'arcs',
  points: 140,
  spacing: 4,
  steps: 220,
  noiseScale: 0.04,
})

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)

registerElement('generative', {
  label: 'Generative',
  describe: (p: GenerativeParams) => GEN_KINDS.find((k) => k.key === p.kind)?.name ?? null,
  generate: (p: GenerativeParams): Geometry => {
    if (p.width <= 0 || p.height <= 0) return []
    return generativeGeometry(JSON.stringify(p))
  },
  isLocked: () => false,
  applyScale: (p: GenerativeParams, sx, sy) => ({
    ...p,
    width: Math.max(1, p.width * Math.abs(sx)),
    height: Math.max(1, p.height * Math.abs(sy)),
  }),
  sanitizeParams: (raw) => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const d = defaultGenerativeParams()
    const kind = (GEN_KINDS.find((k) => k.key === o.kind)?.key ?? 'spirograph') as GenKind
    return {
      kind,
      seed: num(o.seed, d.seed),
      width: Math.max(1, num(o.width, d.width)),
      height: Math.max(1, num(o.height, d.height)),
      outerR: num(o.outerR, d.outerR),
      innerR: num(o.innerR, d.innerR),
      penOffset: num(o.penOffset, d.penOffset),
      preset: LSYSTEM_PRESETS.includes(str(o.preset, '')) ? (o.preset as string) : d.preset,
      iterations: Math.max(0, Math.min(10, Math.round(num(o.iterations, d.iterations)))),
      angle: num(o.angle, d.angle),
      cell: Math.max(2, num(o.cell, d.cell)),
      style: o.style === 'lines' ? 'lines' : 'arcs',
      points: Math.max(3, Math.round(num(o.points, d.points))),
      spacing: Math.max(0.5, num(o.spacing, d.spacing)),
      steps: Math.max(2, Math.round(num(o.steps, d.steps))),
      noiseScale: num(o.noiseScale, d.noiseScale),
    } as GenerativeParams
  },
})
