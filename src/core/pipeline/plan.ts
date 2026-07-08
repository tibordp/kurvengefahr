// Stage (axidraw only): optimized geometry → the EBB motion plan. The Rust planner
// (crate/src/plan.rs) does everything through step quantization and LM term encoding; this is
// just the marshal. The plan is a flat segment tape the streaming session (src/output/ebb)
// executes over Web Serial.
import type { AxidrawProfile, Fiducial, Geometry } from '../types'
import { initWasm, plan_axidraw as wasmPlan } from '../wasm'
import { flatten } from '../wasm/serde'
import { penParkInPage } from './toMachine'
import { STEPS_PER_MM, type PlotPlan } from './planTypes'

export { SEG, STEPS_PER_MM, type PlotPlan } from './planTypes'

/** How far apart (in seconds) the planner may space its forced rest points — the only places the
 *  streaming loop can pause, so this bounds "Pausing…" latency on huge strokes. */
const MAX_BLOCK_SECONDS = 5

/** Plan a whole AxiDraw job from optimized page-space geometry (page mm = machine mm for this
 *  kind: top-left origin, zero pen offset). Empty geometry → an empty plan (nothing to stream). */
export async function planAxidraw(
  geom: Geometry,
  profile: AxidrawProfile,
  fiducial?: Fiducial | null,
): Promise<PlotPlan> {
  await initWasm()
  const park = penParkInPage(profile)
  const params = {
    stepsPerMm: STEPS_PER_MM,
    drawSpeed: profile.motion.drawSpeed,
    travelSpeed: profile.motion.travelSpeed,
    acceleration: profile.motion.acceleration,
    cornering: profile.motion.cornering,
    liftMs: profile.servo.liftMs,
    dropMs: profile.servo.dropMs,
    start: [park.x, park.y],
    fiducial: fiducial ? [fiducial.x, fiducial.y] : null,
    maxBlockSeconds: MAX_BLOCK_SECONDS,
  }
  const flat = flatten(geom)
  const res = wasmPlan(
    flat.xy,
    flat.pressure,
    flat.offsets,
    flat.pen,
    flat.reversible,
    flat.group,
    JSON.stringify(params),
  )
  // Copy the arrays out before freeing the Rust-owned struct.
  const plan: PlotPlan = {
    kind: res.kind,
    steps1: res.steps1,
    steps2: res.steps2,
    rate1: res.rate1,
    rate2: res.rate2,
    delta1: res.delta1,
    delta2: res.delta2,
    durationMs: res.duration_ms,
    dist: res.dist,
    x: res.x,
    y: res.y,
    pen: res.pen,
    blockStart: res.block_start,
    totalDurationMs: res.total_duration_ms,
    totalDist: res.total_dist,
    length: res.kind.length,
  }
  res.free()
  return plan
}
