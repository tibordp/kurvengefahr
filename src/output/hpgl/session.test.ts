import { describe, expect, it } from 'vitest'
import type { Geometry } from '../../core/types'
import { HPGL_CUTTER } from '../../store/profiles'
import { planGrblTape } from '../../core/pipeline/grblTape'
import type { SessionHooks } from '../session'
import { HpglRun, type HpglLink } from './session'

const profile = { ...structuredClone(HPGL_CUTTER), origin: 'top-left' as const }

const stroke = (pts: [number, number][], pen = 0): Geometry[number] => ({
  points: pts.map(([x, y]) => ({ x, y })),
  pen,
  reversible: true,
})

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeLink() {
  const sent: string[] = []
  let flow: (xon: boolean) => void = () => {}
  const link: HpglLink = {
    write: async (d) => void sent.push(d),
    onFlow: (cb) => (flow = cb),
    onDisconnect: () => {},
  }
  return { link, sent, flow: (xon: boolean) => flow(xon) }
}

function hooks(over: Partial<SessionHooks> = {}): SessionHooks {
  return { onProgress: () => {}, onPaused: () => {}, onResumed: () => {}, prompt: async () => true, ...over }
}

describe('HpglRun', () => {
  it('streams the same commands as the file, holding writes while XOFF', async () => {
    const tape = planGrblTape([stroke([[1, 1], [2, 1]])], profile, null, Infinity)
    const { link, sent, flow } = fakeLink()
    const run = new HpglRun(tape, link, profile, hooks())
    flow(false)
    const done = run.run()
    await tick()
    expect(sent).toEqual([])
    flow(true)
    expect(await done).toBe('done')
    expect(sent).toEqual(['IN;SP1;PA;', 'PU;', 'PU40,40;', 'PD;', 'PD80,40;', 'PU;', 'PU0,0;'])
  })

  it('a declined pen-swap prompt cancels: nothing more of the job, then pen up + home', async () => {
    const tape = planGrblTape([stroke([[1, 1], [2, 1]], 0), stroke([[3, 3], [4, 3]], 1)], profile, null, Infinity)
    const { link, sent } = fakeLink()
    const prompts: string[] = []
    const run = new HpglRun(tape, link, profile, hooks({ prompt: async (k) => (prompts.push(k), false) }))
    expect(await run.run()).toBe('cancelled')
    expect(prompts).toEqual(['penSwap'])
    expect(sent.at(-1)).toBe('PU;PU0,0;')
    expect(sent).not.toContain('PU120,120;')
  })

  it('pauses only at a stroke start', async () => {
    const tape = planGrblTape([stroke([[1, 1], [2, 1]]), stroke([[3, 3], [4, 3]])], profile, null, Infinity)
    const { link, sent } = fakeLink()
    let run!: HpglRun
    let paused = 0
    run = new HpglRun(
      tape,
      link,
      profile,
      hooks({
        onPaused: () => paused++,
        onProgress: (i) => {
          if (i === 2) run.requestPause() // mid-stroke 1 (pen just went down)
        },
      }),
    )
    const done = run.run()
    await tick()
    expect(paused).toBe(1)
    expect(sent.at(-1)).toBe('PU;') // stroke 1 finished, stroke 2's travel not sent
    run.requestResume()
    expect(await done).toBe('done')
    expect(sent).toContain('PU120,120;')
  })

  it('from the head: cancel walks back by the relative delta', async () => {
    const head = { ...profile, startAt: 'head' as const }
    const tape = planGrblTape([stroke([[1, 1], [2, 1]], 0), stroke([[3, 3], [4, 3]], 1)], head, null, Infinity)
    const { link, sent } = fakeLink()
    expect(await new HpglRun(tape, link, head, hooks({ prompt: async () => false })).run()).toBe('cancelled')
    expect(sent[0]).toBe('SP1;PR;')
    expect(sent.at(-1)).toBe('PU;PU-80,-40;')
  })
})
