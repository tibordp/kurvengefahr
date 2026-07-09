import { describe, expect, it, vi } from 'vitest'
import { MockGrbl } from './mock'
import { Grbl, GrblError, type GrblStatus } from './protocol'

describe('Grbl protocol', () => {
  it('acks resolve in FIFO order under mixed delays', async () => {
    const t = new MockGrbl({ ackDelayMs: (l) => (l.startsWith('G1') ? 20 : 1) })
    const grbl = new Grbl(t)
    const order: string[] = []
    await Promise.all([
      grbl.send('G1 X10 Y0 F1500').then(() => order.push('slow')),
      grbl.send('G21').then(() => order.push('fast')),
    ])
    expect(order).toEqual(['slow', 'fast']) // serial wire: replies never overtake
    expect(t.sent).toEqual(['G1 X10 Y0 F1500', 'G21'])
  })

  it('error:N rejects that command with its code, later commands still ack', async () => {
    const t = new MockGrbl({ reply: (l) => (l === 'G93' ? ['error:20'] : null) })
    const grbl = new Grbl(t)
    const bad = grbl.send('G93')
    const good = grbl.send('G21')
    await expect(bad).rejects.toMatchObject({ code: 20 })
    await expect(good).resolves.toBeUndefined()
  })

  it('status reports answer ? without consuming the ack FIFO', async () => {
    const t = new MockGrbl({ ackDelayMs: 15 })
    const grbl = new Grbl(t)
    const statuses: GrblStatus[] = []
    grbl.onStatus((s) => statuses.push(s))
    const pending = grbl.send('G0 X5 Y5')
    grbl.statusQuery() // lands mid-command; its report must not steal the pending ok
    await vi.waitFor(() => expect(statuses.length).toBe(1))
    expect(statuses[0].state).toBe('Run')
    await expect(pending).resolves.toBeUndefined()
    await vi.waitFor(async () => {
      grbl.statusQuery()
      await Promise.resolve()
      expect(statuses.at(-1)?.state).toBe('Idle')
    })
    expect(statuses.at(-1)?.wpos).toEqual({ x: 5, y: 5, z: 0 })
  })

  it('derives WPos from MPos − WCO when the report carries machine coords', async () => {
    const t = new MockGrbl({ reportMPos: true })
    const grbl = new Grbl(t)
    const statuses: GrblStatus[] = []
    grbl.onStatus((s) => statuses.push(s))
    await grbl.send('G0 X7 Y3')
    grbl.statusQuery() // first report includes WCO
    grbl.statusQuery() // second doesn't — must reuse the tracked WCO
    await vi.waitFor(() => expect(statuses.length).toBe(2))
    expect(statuses[1].wpos).toEqual({ x: 7, y: 3, z: 0 })
  })

  it('ALARM rejects everything pending and fires onAlarm', async () => {
    const t = new MockGrbl({ ackDelayMs: 50 })
    const grbl = new Grbl(t)
    const alarms: number[] = []
    grbl.onAlarm((c) => alarms.push(c))
    const a = grbl.send('G0 X1 Y1')
    const b = grbl.send('G0 X2 Y2')
    t.injectAlarm(1)
    await expect(a).rejects.toBeInstanceOf(GrblError)
    await expect(b).rejects.toBeInstanceOf(GrblError)
    expect(alarms).toEqual([1])
  })

  it('softReset rejects in-flight sends and resolves with the banner', async () => {
    const t = new MockGrbl({ ackDelayMs: 1000 })
    const grbl = new Grbl(t)
    const doomed = grbl.send('G0 X9 Y9')
    const banner = grbl.softReset()
    await expect(doomed).rejects.toThrow('reset')
    await expect(banner).resolves.toMatch(/^Grbl 1\.1/)
  })

  it('waitBanner catches the connect-time banner and times out without one', async () => {
    const t = new MockGrbl()
    const grbl = new Grbl(t)
    const banner = grbl.waitBanner(1000)
    t.boot()
    await expect(banner).resolves.toMatch(/^Grbl /)
    await expect(new Grbl(new MockGrbl()).waitBanner(20)).rejects.toThrow('timed out')
  })

  it('feed hold stalls acks; resume releases them', async () => {
    const t = new MockGrbl()
    const grbl = new Grbl(t)
    grbl.feedHold()
    const held = grbl.send('G0 X1 Y0')
    let settled = false
    void held.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    grbl.cycleResume()
    await expect(held).resolves.toBeUndefined()
  })

  it('unplug rejects pending sends and fires onDisconnect', async () => {
    const t = new MockGrbl({ ackDelayMs: 100 })
    const grbl = new Grbl(t)
    let disconnected = false
    grbl.onDisconnect(() => (disconnected = true))
    const pending = grbl.send('G0 X1 Y1')
    t.unplug()
    await expect(pending).rejects.toThrow('disconnected')
    expect(disconnected).toBe(true)
    await expect(grbl.send('G21')).rejects.toThrow('disconnected')
  })
})
