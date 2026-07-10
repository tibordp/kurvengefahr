// Full-pipeline invariants with the REAL WASM module (loaded from disk bytes): generate → place →
// clip → optimize → emit. Coarse contracts only — exact geometry belongs to the crate's own tests.
// Requires crate/pkg (built by predev/prebuild; `npm run build:wasm` if stale).
import { beforeAll, describe, expect, it } from 'vitest'
import '../../elements/shapes'
import { initWasmForTests } from '../wasm/nodeTestInit'
import { defaultRectParams } from '../../elements/shapes'
import { IDENTITY_TRANSFORM, type DocElement, type Geometry, type PrusaProfile, type Stroke } from '../types'
import { PRUSA_MK4 } from '../../store/profiles'
import { buildPageGeometry } from './index'
import { clipToRegion, drawableRegion } from './clip'
import { optimizeGeometry } from './optimize'
import { plotStartInPage } from './toMachine'
import { emit } from './emit'

beforeAll(async () => {
  await initWasmForTests()
})

function profile(over: Partial<PrusaProfile> = {}): PrusaProfile {
  return {
    ...structuredClone(PRUSA_MK4),
    bed: { width: 100, height: 80 },
    penOffset: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

const rectElement = (x: number, y: number, w: number, h: number): DocElement => ({
  id: `rect-${x}-${y}`,
  type: 'rect',
  transform: { ...IDENTITY_TRANSFORM, x, y },
  params: { ...defaultRectParams(w, h) },
  pen: 0,
})

const stroke = (pts: [number, number][], pen = 0, over: Partial<Stroke> = {}): Stroke => ({
  points: pts.map(([x, y]) => ({ x, y })),
  pen,
  reversible: true,
  ...over,
})

/** Canonical multiset key of a stroke's ink (endpoints, orientation-insensitive). */
const inkKeys = (geom: Geometry) =>
  geom
    .map((s) => {
      const ends = [s.points[0], s.points[s.points.length - 1]]
        .map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
        .sort()
      return `${s.pen}|${ends.join('~')}`
    })
    .sort()

describe('generate → place → clip', () => {
  it('keeps every clipped point inside the drawable region, offset and origin included', () => {
    // 10 mm pen offset + bottom-left origin: the unreachable strip is at the page top for y.
    const p = profile({ origin: 'bottom-left', penOffset: { x: 10, y: 8, z: 0 } })
    const region = drawableRegion(p)
    // A rect straddling the region boundary: part of its outline is reachable, part is not.
    const page = buildPageGeometry([rectElement(-30, -30, 90, 80)])
    expect(page.length).toBeGreaterThan(0)
    const clipped = clipToRegion(page, region)
    expect(clipped.length).toBeGreaterThan(0)
    for (const s of clipped)
      for (const pt of s.points) {
        expect(pt.x).toBeGreaterThanOrEqual(region.x0 - 1e-3)
        expect(pt.x).toBeLessThanOrEqual(region.x1 + 1e-3)
        expect(pt.y).toBeGreaterThanOrEqual(region.y0 - 1e-3)
        expect(pt.y).toBeLessThanOrEqual(region.y1 + 1e-3)
      }
  })
})

describe('optimize', () => {
  const scattered: Geometry = [
    stroke([[50, 50], [60, 50]], 1),
    stroke([[5, 5], [10, 5]], 0),
    stroke([[90, 70], [80, 70]], 1),
    stroke([[30, 20], [20, 20]], 0),
    // A locked chain: fixed direction, must stay contiguous and in order.
    stroke([[70, 10], [75, 10]], 0, { group: 9, reversible: false }),
    stroke([[75, 10], [75, 15]], 0, { group: 9, reversible: false }),
  ]

  it('keeps pen groups contiguous in palette order and chains intact', async () => {
    const p = profile()
    const out = await optimizeGeometry(scattered, plotStartInPage(p), [0, 1])
    // Pens partition the output: all pen-0 strokes, then all pen-1 strokes.
    expect(out.map((s) => s.pen)).toEqual([0, 0, 0, 0, 1, 1])
    // The chain is contiguous and in original drawing order/direction.
    const chain = out.map((s, i) => (s.group ? i : -1)).filter((i) => i >= 0)
    expect(chain[1]).toBe(chain[0] + 1)
    expect(out[chain[0]].points[0]).toMatchObject({ x: 70, y: 10 })
    expect(out[chain[1]].points.at(-1)).toMatchObject({ x: 75, y: 15 })
  })

  it('reorders and flips but never adds, drops, or moves ink', async () => {
    const out = await optimizeGeometry(scattered, plotStartInPage(profile()), [0, 1])
    expect(inkKeys(out)).toEqual(inkKeys(scattered))
  })
})

describe('the full chain to G-code', () => {
  it('emits coordinates that stay within the machine bed', async () => {
    const p = profile({ origin: 'bottom-left', penOffset: { x: 6, y: 4, z: 1 } })
    const page = buildPageGeometry([rectElement(-15, -10, 120, 100), rectElement(20, 20, 30, 20)])
    const clipped = clipToRegion(page, drawableRegion(p))
    const ordered = await optimizeGeometry(clipped, plotStartInPage(p), [0])
    const gcode = emit(ordered, p)

    const coords = [...gcode.matchAll(/^G[01] X(-?[\d.]+) Y(-?[\d.]+)/gm)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }))
    expect(coords.length).toBeGreaterThan(0)
    for (const c of coords) {
      // Nozzle coords = pen target − offset; pen targets live in bed ∩ (bed + offset), so the
      // commanded nozzle position must stay on the bed.
      expect(c.x).toBeGreaterThanOrEqual(-1e-3)
      expect(c.x).toBeLessThanOrEqual(p.bed.width + 1e-3)
      expect(c.y).toBeGreaterThanOrEqual(-1e-3)
      expect(c.y).toBeLessThanOrEqual(p.bed.height + 1e-3)
    }
  })
})
