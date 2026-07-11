// Proof-of-work cross-implementation pinning, against the normative fixture
// (share-api/testdata/pow_vectors.json — also asserted by share-api's and kg_core's Rust tests):
//  1. `difficultyBits` reproduces the server's formula on the fixture's table.
//  2. An independent WebCrypto reimplementation of the PoW digest (no Rust in the loop) matches
//     the fixture — this is what pins the byte layout (32-byte hash || little-endian u64 nonce).
//  3. The real WASM `pow_scan`/`pow_verify` agree with the fixture.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { initWasmForTests } from '../core/wasm/nodeTestInit'
import { difficultyBits } from './pow'

interface Fixture {
  algorithm: string
  params: { base_bits: number; size_step: number; max_bits: number }
  difficulty_table: { len: number; difficulty: number }[]
  vectors: {
    blob_hash_hex: string
    id: string
    cases: { nonce: number; pow_digest_hex: string; leading_zero_bits: number }[]
  }[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../share-api/testdata/pow_vectors.json', import.meta.url), 'utf8'),
) as Fixture

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** Independent implementation of the pinned digest: SHA-256(hash(32) || nonce as LE u64). */
async function powDigest(blobHash: Uint8Array, nonce: bigint): Promise<Uint8Array> {
  const msg = new Uint8Array(40)
  msg.set(blobHash, 0)
  new DataView(msg.buffer).setBigUint64(32, nonce, true /* little-endian */)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', msg))
}

function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0
  for (const b of digest) {
    if (b === 0) {
      bits += 8
    } else {
      bits += Math.clz32(b) - 24
      break
    }
  }
  return bits
}

describe('difficultyBits', () => {
  it('matches the fixture table', () => {
    const p = {
      baseBits: fixture.params.base_bits,
      sizeStep: fixture.params.size_step,
      maxBits: fixture.params.max_bits,
    }
    for (const { len, difficulty } of fixture.difficulty_table) {
      expect(difficultyBits(len, p), `len=${len}`).toBe(difficulty)
    }
  })
})

describe('pow digest byte layout (WebCrypto, no Rust)', () => {
  it('matches every fixture case', async () => {
    expect(fixture.algorithm).toBe('sha256-lz-v1')
    for (const vector of fixture.vectors) {
      const blobHash = unhex(vector.blob_hash_hex)
      for (const c of vector.cases) {
        const digest = await powDigest(blobHash, BigInt(c.nonce))
        expect(hex(digest)).toBe(c.pow_digest_hex)
        expect(leadingZeroBits(digest)).toBe(c.leading_zero_bits)
      }
    }
  })
})

describe('wasm pow_scan / pow_verify', () => {
  beforeAll(async () => {
    await initWasmForTests()
  })

  it('verifies fixture cases at their exact bit counts', async () => {
    const { pow_verify } = await import('@wasm/kg_core.js')
    for (const vector of fixture.vectors) {
      const blobHash = unhex(vector.blob_hash_hex)
      for (const c of vector.cases) {
        expect(pow_verify(blobHash, BigInt(c.nonce), c.leading_zero_bits)).toBe(true)
        expect(pow_verify(blobHash, BigInt(c.nonce), c.leading_zero_bits + 1)).toBe(false)
      }
    }
  })

  it('scan finds a nonce the independent implementation accepts', async () => {
    const { pow_scan } = await import('@wasm/kg_core.js')
    const blobHash = unhex(fixture.vectors[0].blob_hash_hex)
    const found = pow_scan(blobHash, 0n, 1 << 20, 12)
    expect(found).toBeDefined()
    expect(leadingZeroBits(await powDigest(blobHash, found!))).toBeGreaterThanOrEqual(12)
    // A window known (from the fixture) to contain no qualifying nonce returns undefined.
    expect(pow_scan(blobHash, 0n, 1, 255)).toBeUndefined()
  })
})
