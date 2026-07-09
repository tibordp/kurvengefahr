// Live end-to-end test against a real GRBL board on a serial device. Opt-in: set
// GRBL_DEVICE=/dev/cu.usbserialXXXX (and GRBL_BAUD, default 115200) — skipped entirely
// otherwise, so CI never needs hardware. Drives the exact same Grbl/GrblRun classes the app
// uses, through the Node fs transport instead of Web Serial.
//
// The board WILL move (a few cm around wherever it sits) — clear the work area first. Run with
// the pen holder empty.
import { describe, expect, it } from 'vitest'
import type { Geometry, GrblProfile } from '../../core/types'
import { GRBL_PLOTTER } from '../../store/profiles'
import { planGrblTape } from '../../core/pipeline/grblTape'
import { NodeSerialTransport } from '../serial/nodeTransport'
import { Grbl, type GrblStatus } from './protocol'
import { GrblRun, type GrblSessionHooks } from './session'

const DEVICE = process.env.GRBL_DEVICE
const BAUD = parseInt(process.env.GRBL_BAUD ?? '115200', 10)

const PROFILE: GrblProfile = {
  ...structuredClone(GRBL_PLOTTER),
  origin: 'top-left', // machine == page coords, keeps the test geometry literal
  homing: false,
}

const stroke = (pts: [number, number][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y]) => ({ x, y })),
  pen,
  reversible: true,
})

describe.runIf(!!DEVICE)('live GRBL', () => {
  async function connect(): Promise<{ grbl: Grbl; done: () => Promise<void> }> {
    const t = await NodeSerialTransport.open(DEVICE!, BAUD)
    const grbl = new Grbl(t)
    // No DTR toggle through the fs transport — provoke the banner with a soft reset instead.
    await grbl.softReset(5000)
    return { grbl, done: () => grbl.close() }
  }

  it('talks the protocol: banner, unlock, status round-trip, a jog and back', async () => {
    const { grbl, done } = await connect()
    try {
      const status = await new Promise<GrblStatus>((resolve) => {
        grbl.onStatus(resolve)
        grbl.statusQuery()
      })
      if (status.state === 'Alarm') await grbl.unlock()
      await grbl.send('G21')
      await grbl.send('G91') // relative, so the round-trip is position-neutral
      await grbl.send('G0 X5 Y5')
      await grbl.send('G0 X-5 Y-5')
      await grbl.send('G90')
      // Wait for idle.
      for (;;) {
        const s = await new Promise<GrblStatus>((resolve) => {
          grbl.onStatus(resolve)
          grbl.statusQuery()
        })
        if (s.state === 'Idle') break
        await new Promise((r) => setTimeout(r, 100))
      }
    } finally {
      await done()
    }
  }, 20000)

  it('runs a full GrblRun tape with a mid-plot pause and resume', async () => {
    const { grbl, done } = await connect()
    // Two strokes near the origin corner; the tape ends by walking back to work zero (= here).
    const geom: Geometry = [stroke([[10, 10], [30, 10], [30, 30]]), stroke([[10, 30], [30, 50]])]
    const events: string[] = []
    let lastDist = 0
    const hooks: GrblSessionHooks = {
      onProgress: (i) => events.push(`seg${i}`),
      onDist: (mm) => (lastDist = mm),
      onPaused: () => events.push('paused'),
      onResumed: () => events.push('resumed'),
      prompt: async () => true,
    }
    const run = new GrblRun(planGrblTape(geom, PROFILE), grbl, PROFILE, hooks)
    try {
      const finished = run.run()
      setTimeout(() => run.requestPause(), 500)
      const poll = setInterval(() => {
        if (events.includes('paused')) {
          clearInterval(poll)
          run.requestResume()
        }
      }, 100)
      expect(await finished).toBe('done')
      clearInterval(poll)
      expect(events).toContain('paused')
      expect(events).toContain('resumed')
      expect(lastDist).toBeGreaterThan(0) // the machine-driven playhead moved
    } finally {
      await done()
    }
  }, 60000)

  it('cancel mid-plot holds, resets, and walks home', async () => {
    const { grbl, done } = await connect()
    const geom: Geometry = [stroke(Array.from({ length: 30 }, (_, i) => [10 + i, 10 + ((i * 3) % 20)] as [number, number]))]
    const run = new GrblRun(planGrblTape(geom, PROFILE), grbl, PROFILE, {
      onProgress: () => {},
      onDist: () => {},
      onPaused: () => {},
      onResumed: () => {},
      prompt: async () => true,
    })
    try {
      const finished = run.run()
      setTimeout(() => run.requestCancel(), 1500)
      expect(await finished).toBe('cancelled')
      // Back at work zero.
      const s = await new Promise<GrblStatus>((resolve) => {
        grbl.onStatus(resolve)
        grbl.statusQuery()
      })
      expect(s.state).toBe('Idle')
      expect(Math.abs(s.wpos?.x ?? 99)).toBeLessThan(0.1)
      expect(Math.abs(s.wpos?.y ?? 99)).toBeLessThan(0.1)
    } finally {
      await done()
    }
  }, 60000)
})
