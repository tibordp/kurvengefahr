// Encryption contract: roundtrip fidelity, total (never-throw) decryption with the documented
// error taxonomy, and the pinned stored-blob layout (version || iv || ciphertext).
import { describe, expect, it } from 'vitest'
import {
  STORED_VERSION,
  blobIdOf,
  decryptContainer,
  encryptContainer,
  fromBase64Url,
  sha256,
  toBase64Url,
} from './crypto'

const PLAIN = new TextEncoder().encode('PK\x03\x04 pretend kgz payload with some length to it')

describe('encryptContainer / decryptContainer', () => {
  it('roundtrips, with the pinned layout and link-form outputs', async () => {
    const { stored, id, key, fullHash } = await encryptContainer(PLAIN)
    expect(stored[0]).toBe(STORED_VERSION)
    expect(stored.length).toBe(1 + 12 + PLAIN.length + 16) // version + iv + ct + GCM tag
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // The id is the digest's 16-byte truncation; PoW mines the full 32-byte digest.
    expect([...fullHash]).toEqual([...(await sha256(stored))])
    expect(toBase64Url(fullHash.subarray(0, 16))).toBe(id)
    expect(await blobIdOf(stored)).toBe(id)

    const res = await decryptContainer(stored, key)
    expect(res.status).toBe('ok')
    if (res.status === 'ok') expect([...res.plain]).toEqual([...PLAIN])
  })

  it('fresh key and IV per call — same plaintext never repeats a blob', async () => {
    const a = await encryptContainer(PLAIN)
    const b = await encryptContainer(PLAIN)
    expect(a.id).not.toBe(b.id)
    expect(a.key).not.toBe(b.key)
  })

  it('wrong key fails closed as wrong-key', async () => {
    const { stored } = await encryptContainer(PLAIN)
    const { key: otherKey } = await encryptContainer(PLAIN)
    expect((await decryptContainer(stored, otherKey)).status).toBe('wrong-key')
  })

  it('a flipped ciphertext byte fails GCM auth (wrong-key, not garbage output)', async () => {
    const { stored, key } = await encryptContainer(PLAIN)
    const tampered = stored.slice()
    tampered[20] ^= 0x01
    expect((await decryptContainer(tampered, key)).status).toBe('wrong-key')
  })

  it('corrupt inputs are reported as corrupt', async () => {
    const { stored, key } = await encryptContainer(PLAIN)
    const badVersion = stored.slice()
    badVersion[0] = 0x00
    expect((await decryptContainer(badVersion, key)).status).toBe('corrupt')
    expect((await decryptContainer(stored.slice(0, 20), key)).status).toBe('corrupt')
    expect((await decryptContainer(stored, 'not base64url!!')).status).toBe('corrupt')
    expect((await decryptContainer(stored, 'dG9vc2hvcnQ')).status).toBe('corrupt') // wrong key length
  })
})

describe('base64url', () => {
  it('roundtrips arbitrary bytes', () => {
    const bytes = new Uint8Array(300).map((_, i) => (i * 7 + 13) % 256)
    expect([...fromBase64Url(toBase64Url(bytes))!]).toEqual([...bytes])
    expect(toBase64Url(new Uint8Array(0))).toBe('')
    expect([...fromBase64Url('')!]).toEqual([])
  })

  it('rejects non-url-safe input', () => {
    expect(fromBase64Url('a+b')).toBeNull()
    expect(fromBase64Url('a/b')).toBeNull()
    expect(fromBase64Url('a=')).toBeNull()
    expect(fromBase64Url('sp ace')).toBeNull()
  })
})
