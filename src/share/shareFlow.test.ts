// Share pipeline: phase ordering, the oversize guard firing before any proof-of-work, session
// link reuse, and the pending-attempt resume that keeps a paid-for PoW across a failed upload.
// Service + solver mocked; encryption is the real WebCrypto path.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  fetchShareInfo: vi.fn(),
  blobExists: vi.fn(),
  uploadBlob: vi.fn(),
}))
const solvePow = vi.hoisted(() => vi.fn())
const exportActiveDocument = vi.hoisted(() => vi.fn())

vi.mock('./service', () => service)
vi.mock('./pow', async (importActual) => ({
  ...(await importActual<typeof import('./pow')>()),
  solvePow,
}))
vi.mock('../output/documentContainer', () => ({ exportActiveDocument }))
vi.mock('../store/document', () => ({
  useDoc: { getState: () => ({ elements: [], profile: { kind: 'test' }, fiducial: null }) },
}))
vi.mock('../store/documents', () => ({
  useDocuments: { getState: () => ({ activeName: 'Test doc' }) },
}))

import { ShareTooLargeError, resetShareCaches, runShare, type SharePhase } from './shareFlow'

const INFO = {
  maxBytes: 4096,
  pow: { baseBits: 8, sizeStep: 1024, maxBits: 30 },
  retentionDays: 7,
  version: '0.1.0',
}

function run(signal?: AbortSignal) {
  const phases: SharePhase['step'][] = []
  const result = runShare((p) => phases.push(p.step), signal ?? new AbortController().signal)
  return { phases, result }
}

beforeEach(() => {
  resetShareCaches()
  vi.clearAllMocks()
  // node has no location; buildShareUrl needs the app origin
  vi.stubGlobal('location', { origin: 'https://kurvengefahr.org', pathname: '/' })
  service.fetchShareInfo.mockResolvedValue(INFO)
  service.blobExists.mockResolvedValue(false)
  service.uploadBlob.mockResolvedValue(undefined)
  solvePow.mockResolvedValue(42n)
  exportActiveDocument.mockResolvedValue(new Blob([new Uint8Array(100)]))
})

describe('runShare', () => {
  it('happy path: phases in order, link carries hash + key', async () => {
    const { phases, result } = run()
    const res = await result
    expect(phases).toEqual(['exporting', 'encrypting', 'preflight', 'uploading'])
    expect(res.reused).toBe(false)
    expect(res.retentionDays).toBe(7)
    expect(res.url).toMatch(/#s=[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/)
    const [hash, stored, nonce] = service.uploadBlob.mock.calls[0] as [string, Uint8Array, bigint]
    expect(res.url).toContain(hash)
    expect(stored.length).toBe(1 + 12 + 100 + 16)
    expect(nonce).toBe(42n)
  })

  it('reports pow progress phases from the solver', async () => {
    solvePow.mockImplementation((_hash, _bits, opts) => {
      opts.onProgress({ attempts: 1000, probability: 0.5 })
      return Promise.resolve(7n)
    })
    const { phases, result } = run()
    await result
    expect(phases).toContain('pow')
  })

  it('oversize throws before any proof-of-work is attempted', async () => {
    exportActiveDocument.mockResolvedValue(new Blob([new Uint8Array(5000)]))
    await expect(run().result).rejects.toBeInstanceOf(ShareTooLargeError)
    expect(solvePow).not.toHaveBeenCalled()
    expect(service.uploadBlob).not.toHaveBeenCalled()
  })

  it('re-sharing identical content reuses the link without exporting again', async () => {
    const first = await run().result
    service.blobExists.mockResolvedValue(true)
    const second = await run().result
    expect(second.reused).toBe(true)
    expect(second.url).toBe(first.url)
    expect(exportActiveDocument).toHaveBeenCalledTimes(1)
    expect(service.uploadBlob).toHaveBeenCalledTimes(1)
  })

  it('an expired blob falls through to a fresh upload (new link is fine)', async () => {
    await run().result
    service.blobExists.mockResolvedValue(false) // lifecycle rule deleted it
    const again = await run().result
    expect(again.reused).toBe(false)
    expect(service.uploadBlob).toHaveBeenCalledTimes(2)
  })

  it('retry after a failed upload keeps the ciphertext and the solved nonce', async () => {
    service.uploadBlob.mockRejectedValueOnce(new Error('network flake'))
    await expect(run().result).rejects.toThrow('network flake')
    expect(solvePow).toHaveBeenCalledTimes(1)
    const failedHash = (service.uploadBlob.mock.calls[0] as [string])[0]

    const retry = await run().result
    expect(exportActiveDocument).toHaveBeenCalledTimes(1) // not re-exported
    expect(solvePow).toHaveBeenCalledTimes(1) // PoW not re-paid
    expect((service.uploadBlob.mock.calls[1] as [string])[0]).toBe(failedHash)
    expect(retry.url).toContain(failedHash)
  })

  it('a pre-aborted signal rejects without uploading', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(run(ctrl.signal).result).rejects.toMatchObject({ name: 'AbortError' })
    expect(service.uploadBlob).not.toHaveBeenCalled()
  })
})
