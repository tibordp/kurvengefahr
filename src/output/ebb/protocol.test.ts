import { describe, expect, it } from 'vitest'
import { Ebb, EbbError, servoPos, supportsLM } from './protocol'
import { MockTransport } from './mock'

describe('Ebb protocol framing', () => {
  it('V is a single line with no OK', async () => {
    const t = new MockTransport()
    const ebb = new Ebb(t)
    expect(await ebb.version()).toContain('Firmware Version')
    expect(t.sent).toEqual(['V'])
  })

  it('QM parses without an OK terminator', async () => {
    const t = new MockTransport({ reply: (c) => (c === 'QM' ? ['QM,1,1,0,1'] : null) })
    const ebb = new Ebb(t)
    expect(await ebb.queryMotion()).toEqual({ executing: true, motor1: true, motor2: false, fifo: true })
  })

  it('data lines + OK resolve with the data', async () => {
    const t = new MockTransport({ reply: (c) => (c === 'QS' ? ['123,-456'] : null) })
    const ebb = new Ebb(t)
    expect(await ebb.querySteps()).toEqual([123, -456])
  })

  it('an ! error rejects immediately (no trailing OK on 3.x)', async () => {
    const t = new MockTransport({ reply: (c) => (c.startsWith('XX') ? ['!8 Err: Unknown command'] : null) })
    const ebb = new Ebb(t)
    await expect(ebb.command('XX')).rejects.toThrow(EbbError)
    // the connection stays usable
    expect(await ebb.queryButton()).toBe(false)
  })

  it('matches replies to commands in FIFO order even with mixed delays', async () => {
    const t = new MockTransport({
      ackDelayMs: (cmd) => (cmd.startsWith('SM') ? 20 : 1),
      reply: (c) => (c === 'QS' ? ['7,7'] : null),
    })
    const ebb = new Ebb(t)
    const [sm, qs] = await Promise.all([ebb.move(100, 10, 10), ebb.querySteps()])
    expect(sm).toEqual([])
    expect(qs).toEqual([7, 7])
  })

  it('rejects pending commands on disconnect', async () => {
    const t = new MockTransport({ ackDelayMs: 50 })
    const ebb = new Ebb(t)
    const pending = ebb.move(100, 10, 10)
    t.unplug()
    await expect(pending).rejects.toThrow('disconnected')
    await expect(ebb.queryButton()).rejects.toThrow('disconnected')
  })
})

describe('servoPos', () => {
  it('maps percent onto the practical AxiDraw pulse range', () => {
    expect(servoPos(0)).toBe(7500)
    expect(servoPos(100)).toBe(28000)
    expect(servoPos(50)).toBe(17750)
    expect(servoPos(-5)).toBe(7500)
    expect(servoPos(200)).toBe(28000)
  })
})

describe('supportsLM', () => {
  it('gates on firmware 2.7.0', () => {
    expect(supportsLM('EBBv13_and_above EB Firmware Version 2.5.4')).toBe(false)
    expect(supportsLM('EBBv13_and_above EB Firmware Version 2.7.0')).toBe(true)
    expect(supportsLM('EBBv13_and_above EB Firmware Version 3.0.3')).toBe(true)
    expect(supportsLM('garbage')).toBe(false)
  })
})
