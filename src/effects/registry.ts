// Effect registry: the per-type metadata the UI + persistence need (label, defaults, the inspector
// control list, whether it's seeded). The actual compute is a single Rust dispatch (crate/effects,
// via core/wasm/effects.ts) — adding an effect = a Rust submodule + match arm + serde fields + one
// entry here + (it renders generically in the inspector). Field names match the Rust EffectSpec.
import type { EffectSpec, EffectType } from '../core/types'

/** A control rendered generically by the inspector for one effect param: a slider+number for
 *  numeric knobs, or a checkbox when `bool` is set. */
export type EffectControl =
  | { key: string; label: string; min: number; max: number; step: number; int?: boolean; bool?: never }
  | { key: string; label: string; bool: true }

export interface EffectDef {
  type: EffectType
  label: string
  /** Has a `seed` (re-rollable with the dice button). */
  seeded: boolean
  defaults: () => EffectSpec
  controls: EffectControl[]
}

const DEFS: Record<EffectType, EffectDef> = {
  roughen: {
    type: 'roughen',
    label: 'Roughen (hand-drawn)',
    seeded: true,
    defaults: () => ({ type: 'roughen', enabled: true, amplitudeMm: 1, detailMm: 4, tremorMm: 0, seed: 1 }),
    controls: [
      { key: 'amplitudeMm', label: 'Amount (mm)', min: 0, max: 10, step: 0.1 },
      { key: 'detailMm', label: 'Detail (mm)', min: 0.5, max: 20, step: 0.5 },
      { key: 'tremorMm', label: 'Tremor (mm)', min: 0, max: 3, step: 0.1 },
    ],
  },
  smooth: {
    type: 'smooth',
    label: 'Smooth',
    seeded: false,
    defaults: () => ({ type: 'smooth', enabled: true, detailMm: 1, strength: 0.5, iterations: 6 }),
    controls: [
      { key: 'detailMm', label: 'Resolution (mm)', min: 0.25, max: 10, step: 0.25 },
      { key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 },
      { key: 'iterations', label: 'Iterations', min: 1, max: 30, step: 1, int: true },
    ],
  },
  wave: {
    type: 'wave',
    label: 'Wave / warp',
    seeded: false,
    defaults: () => ({ type: 'wave', enabled: true, amplitudeMm: 3, wavelengthMm: 30, angleDeg: 0, phaseDeg: 0, harmonics: 1 }),
    controls: [
      { key: 'amplitudeMm', label: 'Amplitude (mm)', min: -20, max: 20, step: 0.5 },
      { key: 'wavelengthMm', label: 'Wavelength (mm)', min: 1, max: 200, step: 1 },
      { key: 'angleDeg', label: 'Angle (°)', min: 0, max: 360, step: 5 },
      { key: 'phaseDeg', label: 'Phase (°)', min: 0, max: 360, step: 5 },
      { key: 'harmonics', label: 'Harmonics', min: 1, max: 5, step: 1, int: true },
    ],
  },
  sketch: {
    type: 'sketch',
    label: 'Sketch (overdraw)',
    seeded: true,
    defaults: () => ({ type: 'sketch', enabled: true, passes: 2, offsetMm: 0.6, seed: 1 }),
    controls: [
      { key: 'passes', label: 'Passes', min: 2, max: 6, step: 1, int: true },
      { key: 'offsetMm', label: 'Offset (mm)', min: 0, max: 3, step: 0.1 },
    ],
  },
  twist: {
    type: 'twist',
    label: 'Twist / swirl',
    seeded: false,
    defaults: () => ({ type: 'twist', enabled: true, angleDeg: 30, radiusMm: 50 }),
    controls: [
      { key: 'angleDeg', label: 'Angle (°)', min: -360, max: 360, step: 5 },
      { key: 'radiusMm', label: 'Radius (mm)', min: 1, max: 300, step: 1 },
    ],
  },
  bulge: {
    type: 'bulge',
    label: 'Bulge / pinch',
    seeded: false,
    defaults: () => ({ type: 'bulge', enabled: true, strength: 0.4, radiusMm: 50 }),
    controls: [
      { key: 'strength', label: 'Strength', min: -1, max: 1, step: 0.05 },
      { key: 'radiusMm', label: 'Radius (mm)', min: 1, max: 300, step: 1 },
    ],
  },
  taper: {
    type: 'taper',
    label: 'Taper (calligraphy)',
    seeded: false,
    defaults: () => ({ type: 'taper', enabled: true, startMm: 6, endMm: 6, minPressure: 0 }),
    controls: [
      { key: 'startMm', label: 'Taper in (mm)', min: 0, max: 50, step: 0.5 },
      { key: 'endMm', label: 'Taper out (mm)', min: 0, max: 50, step: 0.5 },
      { key: 'minPressure', label: 'Tip pressure', min: 0, max: 1, step: 0.05 },
    ],
  },
  offset: {
    type: 'offset',
    label: 'Offset (inset / outset)',
    seeded: false,
    defaults: () => ({ type: 'offset', enabled: true, offsetMm: 2 }),
    controls: [{ key: 'offsetMm', label: 'Distance (mm)', min: -20, max: 20, step: 0.1 }],
  },
  hull: {
    type: 'hull',
    label: 'Hull (outline)',
    seeded: false,
    defaults: () => ({ type: 'hull', enabled: true, convex: false }),
    controls: [{ key: 'convex', label: 'Convex', bool: true }],
  },
}

export const EFFECT_DEFS: EffectDef[] = Object.values(DEFS)

export function effectDef(type: string): EffectDef | undefined {
  return DEFS[type as EffectType]
}

export const effectLabel = (type: string): string => effectDef(type)?.label ?? type

/** Make a fresh default spec for `type` (used by the "Add effect" menu). */
export function defaultEffect(type: EffectType): EffectSpec {
  return DEFS[type].defaults()
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Coerce persisted/imported effects into valid specs: drop unknown types, backfill each known
 *  numeric field from its default, keep `enabled`/`seed`. Total — never throws. */
export function sanitizeEffects(raw: unknown): EffectSpec[] {
  if (!Array.isArray(raw)) return []
  const out: EffectSpec[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const def = effectDef((f as { type?: unknown }).type as string)
    if (!def) continue
    const base = def.defaults() as unknown as Record<string, unknown>
    const src = f as Record<string, unknown>
    const spec: Record<string, unknown> = { type: def.type, enabled: src.enabled !== false }
    for (const c of def.controls)
      spec[c.key] = c.bool
        ? (typeof src[c.key] === 'boolean' ? src[c.key] : (base[c.key] as boolean))
        : num(src[c.key], base[c.key] as number)
    if (def.seeded) spec.seed = num(src.seed, base.seed as number)
    out.push(spec as unknown as EffectSpec)
  }
  return out
}
