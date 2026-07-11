// Fragment codec: the null (not a share link) vs 'invalid' (broken share link) distinction is
// what separates "boot the editor" from "show the bad-link screen".
import { describe, expect, it } from 'vitest'
import { buildShareUrl, parseShareFragment, type ShareRef } from './link'

const REF: ShareRef = { hash: 'A'.repeat(43), key: 'B'.repeat(22) }

describe('parseShareFragment', () => {
  it('roundtrips through buildShareUrl', () => {
    const url = buildShareUrl(REF, 'https://kurvengefahr.org/')
    expect(url).toBe(`https://kurvengefahr.org/#s=${'A'.repeat(43)}.${'B'.repeat(22)}`)
    expect(parseShareFragment(new URL(url).hash)).toEqual(REF)
  })

  it('non-share fragments are null (editor boots normally)', () => {
    expect(parseShareFragment('')).toBeNull()
    expect(parseShareFragment('#')).toBeNull()
    expect(parseShareFragment('#foo')).toBeNull()
    expect(parseShareFragment('#settings=1')).toBeNull()
  })

  it("malformed share fragments are 'invalid' (bad-link screen)", () => {
    expect(parseShareFragment('#s=')).toBe('invalid')
    expect(parseShareFragment(`#s=${'A'.repeat(43)}`)).toBe('invalid') // key missing
    expect(parseShareFragment(`#s=${'A'.repeat(42)}.${'B'.repeat(22)}`)).toBe('invalid') // short hash
    expect(parseShareFragment(`#s=${'A'.repeat(43)}.${'B'.repeat(21)}`)).toBe('invalid') // truncated key
    expect(parseShareFragment(`#s=${'A'.repeat(43)}.${'B'.repeat(22)}x`)).toBe('invalid') // trailing junk
    expect(parseShareFragment(`#s=${'+'.repeat(43)}.${'B'.repeat(22)}`)).toBe('invalid') // bad alphabet
  })
})
