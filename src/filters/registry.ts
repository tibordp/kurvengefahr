// Filter registry: the per-type metadata the UI + persistence need (label, defaults, the inspector
// control list, whether it's seeded). The actual compute is a single Rust dispatch (crate/filters,
// via core/wasm/filters.ts) — adding a filter = a Rust submodule + match arm + serde fields + one
// entry here + (it renders generically in the inspector). Field names match the Rust FilterSpec.
import type { FilterSpec, FilterType } from '../core/types'

/** A numeric control rendered generically by the inspector for one filter param. */
export interface FilterControl {
  key: string
  label: string
  min: number
  max: number
  step: number
  int?: boolean
}

export interface FilterDef {
  type: FilterType
  label: string
  /** Has a `seed` (re-rollable with the dice button). */
  seeded: boolean
  defaults: () => FilterSpec
  controls: FilterControl[]
}

const DEFS: Record<FilterType, FilterDef> = {
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
}

export const FILTER_DEFS: FilterDef[] = Object.values(DEFS)

export function filterDef(type: string): FilterDef | undefined {
  return DEFS[type as FilterType]
}

export const filterLabel = (type: string): string => filterDef(type)?.label ?? type

/** Make a fresh default spec for `type` (used by the "Add filter" menu). */
export function defaultFilter(type: FilterType): FilterSpec {
  return DEFS[type].defaults()
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** Coerce persisted/imported filters into valid specs: drop unknown types, backfill each known
 *  numeric field from its default, keep `enabled`/`seed`. Total — never throws. */
export function sanitizeFilters(raw: unknown): FilterSpec[] {
  if (!Array.isArray(raw)) return []
  const out: FilterSpec[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const def = filterDef((f as { type?: unknown }).type as string)
    if (!def) continue
    const base = def.defaults() as unknown as Record<string, unknown>
    const src = f as Record<string, unknown>
    const spec: Record<string, unknown> = { type: def.type, enabled: src.enabled !== false }
    for (const c of def.controls) spec[c.key] = num(src[c.key], base[c.key] as number)
    if (def.seeded) spec.seed = num(src.seed, base.seed as number)
    out.push(spec as unknown as FilterSpec)
  }
  return out
}
