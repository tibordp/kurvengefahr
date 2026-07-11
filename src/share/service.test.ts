// Share-API client: status → error-kind mapping, info memoization, and the wire shape of PUT.
// All fetches mocked — the real contract is pinned by share-api's own integration tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config', () => ({
  SHARE_API_URL: 'https://share.test',
  POW_HEADER: 'X-KG-PoW',
  shareAvailable: () => true,
}))

import { ShareApiError, blobExists, fetchBlob, fetchShareInfo, resetShareInfoCache, uploadBlob } from './service'

const INFO_BODY = {
  service: 'kg-share-api',
  version: '0.1.0',
  api: 1,
  max_blob_bytes: 5242880,
  pow: { base_bits: 13, size_step: 1024, max_bits: 30 },
  retention_days: 30,
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  resetShareInfoCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function expectKind(promise: Promise<unknown>, kind: ShareApiError['kind']) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ShareApiError)
  expect((err as ShareApiError).kind).toBe(kind)
  return err as ShareApiError
}

describe('fetchShareInfo', () => {
  it('maps snake_case and memoizes across calls', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(INFO_BODY)))
    const info = await fetchShareInfo()
    expect(info).toEqual({
      maxBytes: 5242880,
      pow: { baseBits: 13, sizeStep: 1024, maxBits: 30 },
      retentionDays: 30,
      version: '0.1.0',
    })
    await fetchShareInfo()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://share.test/v1/info')
  })

  it('a failed fetch resets the memo so the next call retries', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expectKind(fetchShareInfo(), 'network')
    fetchMock.mockResolvedValue(new Response(JSON.stringify(INFO_BODY)))
    expect((await fetchShareInfo()).maxBytes).toBe(5242880)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('blobExists', () => {
  it('HEADs and maps 200/404 to boolean', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))
    expect(await blobExists('h'.repeat(43))).toBe(true)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'HEAD' })

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'not_found', message: 'nope' }), { status: 404 }),
    )
    expect(await blobExists('h'.repeat(43))).toBe(false)
  })

  it('other failures propagate as errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
    await expectKind(blobExists('x'), 'server')
  })
})

describe('uploadBlob', () => {
  it('PUTs the bytes with the decimal PoW nonce header', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }))
    const stored = new Uint8Array([1, 2, 3])
    await uploadBlob('someid', stored, 12345678901234567890n)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://share.test/v1/blob/someid')
    expect(init.method).toBe('PUT')
    expect((init.headers as Record<string, string>)['X-KG-PoW']).toBe('12345678901234567890')
    expect(init.body).toBe(stored)
  })

  it('maps the API error statuses', async () => {
    const cases: [number, string, ShareApiError['kind']][] = [
      [413, 'too_large', 'too-large'],
      [403, 'pow_invalid', 'bad-pow'],
      [429, 'rate_limited', 'server'],
      [502, 'storage_error', 'server'],
    ]
    for (const [status, code, kind] of cases) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ code, message: `msg for ${code}` }), { status }),
      )
      const err = await expectKind(uploadBlob('id', new Uint8Array(), 0n), kind)
      expect(err.message).toBe(`msg for ${code}`)
    }
  })
})

describe('fetchBlob', () => {
  it('returns the raw bytes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([9, 8, 7])))
    expect([...(await fetchBlob('id'))]).toEqual([9, 8, 7])
  })

  it('404 is not-found; a dead network is network', async () => {
    fetchMock.mockResolvedValueOnce(new Response('gateway text', { status: 404 }))
    await expectKind(fetchBlob('id'), 'not-found')
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    await expectKind(fetchBlob('id'), 'network')
  })
})
