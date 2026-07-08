// The AxiDraw plan tape's shape and constants — wasm-free on purpose: the EBB session (and its
// tests) consume the tape without touching the planner, which lives behind the Vite-only wasm
// import in plan.ts.

/** Segment kinds in the plan tape (mirrors `crate/src/plan.rs`). */
export const SEG = {
  motion: 0,
  penDown: 1,
  penUp: 2,
  pauseFiducial: 3,
  pausePenswap: 4,
} as const

/** Steps per mm in the X/Y frame at the AxiDraw's native 16× microstepping (`EM,1,1`):
 *  2032 steps/inch. The planner mixes onto the motor axes (m1 = x+y, m2 = x−y) itself. */
export const STEPS_PER_MM = 80

/** The flat plan tape. Parallel typed arrays, one entry per segment; the session iterates them
 *  directly (no per-segment objects). `dist` is the cumulative preview distance at each segment's
 *  end and shares `buildToolpath`'s parameterization, so it drives the live playhead directly. */
export interface PlotPlan {
  kind: Uint8Array
  steps1: Int32Array
  steps2: Int32Array
  rate1: Int32Array
  rate2: Int32Array
  delta1: Int32Array
  delta2: Int32Array
  durationMs: Float32Array
  dist: Float32Array
  x: Float32Array
  y: Float32Array
  pen: Uint16Array
  blockStart: Uint8Array
  totalDurationMs: number
  totalDist: number
  length: number
}
