// The Logo program element: user-authored turtle-graphics source, interpreted in Rust (see
// crate/src/logo/) into strokes. Like raster, this is an **async** worker-backed type that
// re-runs live (debounced) on every source/param edit — the interpreter's deterministic
// step/depth/output limits make runaway programs safe, and on error the last good geometry stays
// on the canvas while the diagnostic shows.
//
// Programs declare inspector knobs with the `param` builtin (`param "size 40 [10 80]`); the
// element stores only the user's overrides in `args`, so an untouched knob follows the source's
// default. Everything in the params object is geometry-affecting (no viewParams): source, args,
// and seed are exactly what the interpreter hashes on.
//
// This is the app's first natively multi-colour generator: `setpen n` stamps per-stroke pens, so
// it registers `multiPen` (concatenation must not overwrite them, and the inspector hides the
// single-pen + stroke sections). The program's pen numbers are PenIds, which the palette assigns
// as 0, 1, 2 … — and every pen consumer already tolerates an id that's since been deleted (the
// canvas falls back to the default ink colour; the optimizer plots stray pens last).
import { registerElement } from '../registry'

export interface LogoParams {
  /** The Logo source program. */
  source: string
  /** Per-param overrides for the program's `param` declarations (absent = source default). */
  args: Record<string, number>
  /** Seed for the program's `random`/`pick` (re-roll = new arrangement, deterministic). */
  seed: number
}

/** The starter program for a fresh element — small, parametric, and obviously editable. */
export const DEFAULT_LOGO_SOURCE = `; A parametric flower -- tweak the knobs in the inspector,
; or edit the code. fd/rt move the turtle; param declares a knob.
param "petals 6 [3 24]
param "size 40 [10 80]

to petal :len
  arc2 60 :len
  rt 120
  arc2 60 :len
  rt 120
end

repeat :petals [
  petal :size
  rt 360 / :petals
]
`

export const defaultLogoParams = (): LogoParams => ({
  source: DEFAULT_LOGO_SOURCE,
  args: {},
  seed: 1,
})

export function sanitizeLogoParams(raw: unknown): LogoParams {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const args: Record<string, number> = {}
  if (p.args && typeof p.args === 'object' && !Array.isArray(p.args)) {
    for (const [k, v] of Object.entries(p.args as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) args[k] = v
    }
  }
  const seed = typeof p.seed === 'number' && Number.isFinite(p.seed) ? Math.max(0, Math.floor(p.seed)) : 1
  return {
    source: typeof p.source === 'string' ? p.source : DEFAULT_LOGO_SOURCE,
    args,
    seed,
  }
}

registerElement('logo', {
  isLocked: () => false,
  sanitizeParams: sanitizeLogoParams,
  // Live re-run on edits (raster-style): the interpreter is fast and hard-limited.
  autoRegenerate: () => true,
  // Program output is intrinsic mm (like handwriting): resize keeps scale in the transform.
  // Natively multi-colour via `setpen` — see the header comment.
  multiPen: true,
})
