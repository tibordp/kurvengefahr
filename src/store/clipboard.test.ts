import { describe, expect, it } from 'vitest'
import { parseClipboard } from './clipboard'

// Mirrors the marker in clipboard.ts. If the prefix there ever changes, this fails on purpose:
// clipboards written by deployed versions would silently stop pasting.
const PREFIX = 'kg-clip/v1:'

describe('parseClipboard', () => {
  it('ignores anything that is not our payload', () => {
    expect(parseClipboard(null)).toBeNull()
    expect(parseClipboard(undefined)).toBeNull()
    expect(parseClipboard('')).toBeNull()
    expect(parseClipboard('some ordinary text')).toBeNull()
    expect(parseClipboard('{"looks":"like json"}')).toBeNull()
  })

  it('never throws on a corrupt payload', () => {
    expect(parseClipboard(PREFIX + 'not json at all')).toBeNull()
    expect(parseClipboard(PREFIX + '{"not":"an array"}')).toBeNull()
    expect(parseClipboard(PREFIX + '[]')).toBeNull()
    expect(parseClipboard(PREFIX + '[{"type":"from-the-future"}]')).toBeNull()
  })

  it('parses and sanitizes a valid payload', () => {
    const els = parseClipboard(
      PREFIX + JSON.stringify([{ id: 'r1', type: 'rect', params: { width: 10, height: 5 }, pen: 2 }]),
    )
    expect(els).toHaveLength(1)
    expect(els![0]).toMatchObject({ id: 'r1', type: 'rect', pen: 2 })
    expect(els![0].transform).toBeDefined() // backfilled by the sanitizer
  })
})
