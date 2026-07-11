// Viewer boot machine: every error kind lands on its screen state, the happy path loads the
// document into `useDoc` without touching localStorage, and "Edit a copy" persists through the
// real storage layer then reloads. Fetch is mocked; crypto, container format and stores are real.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./config', () => ({
  SHARE_API_URL: 'https://share.test',
  POW_HEADER: 'X-KG-PoW',
  shareAvailable: () => true,
}))
const fetchBlob = vi.hoisted(() => vi.fn())
vi.mock('./service', async (importActual) => ({
  ...(await importActual<typeof import('./service')>()),
  fetchBlob,
}))

import { IDENTITY_TRANSFORM } from '../core/types'
import { exportDocumentContainer } from '../output/container'
import { defaultRectParams } from '../elements/shapes'
import { useDoc } from '../store/document'
import { CURRENT_DOC_SCHEMA, documentFile, type StoredDoc } from '../store/persistence/schema'
import { ACTIVE_KEY, INDEX_KEY, docKey } from '../store/persistence/storage'
import { PRUSA_MK4 } from '../store/profiles'
import { encryptContainer } from './crypto'
import { ShareApiError } from './service'
import { bootViewer, resetViewerForTests, saveViewerCopy, useViewer } from './viewer'

function storageStub() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => void map.set(k, v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  }
}

/** A real encrypted share of a minimal one-rect document. */
async function makeShare() {
  const doc: StoredDoc = {
    schemaVersion: CURRENT_DOC_SCHEMA,
    id: 'src-id',
    name: 'Shared masterpiece',
    updatedAt: 1,
    elements: [
      {
        id: 'r1',
        type: 'rect',
        transform: { ...IDENTITY_TRANSFORM, x: 10, y: 10 },
        params: defaultRectParams(20, 15),
        pen: 0,
      },
    ],
    profile: structuredClone(PRUSA_MK4),
    selectedIds: ['r1'], // sender's selection must not survive into the viewer
    fiducial: null,
  }
  const container = await exportDocumentContainer(documentFile(doc), [])
  const plain = new Uint8Array(await container.arrayBuffer())
  return encryptContainer(plain)
}

let localStore: ReturnType<typeof storageStub>
let sessionStore: ReturnType<typeof storageStub>

beforeEach(() => {
  resetViewerForTests()
  vi.clearAllMocks()
  localStore = storageStub()
  sessionStore = storageStub()
  vi.stubGlobal('localStorage', localStore)
  vi.stubGlobal('sessionStorage', sessionStore)
  vi.stubGlobal('location', {
    origin: 'https://kurvengefahr.org',
    pathname: '/',
    hash: '',
    replace: vi.fn(),
  })
  useDoc.getState().loadDocument({ elements: [], profile: structuredClone(PRUSA_MK4), selectedIds: [], fiducial: null })
})

const state = () => useViewer.getState().state

describe('bootViewer', () => {
  it('happy path: loads the doc read-only, selection cleared, zero localStorage writes', async () => {
    const { stored, hash, key } = await makeShare()
    fetchBlob.mockResolvedValue(stored)
    await bootViewer({ hash, key })
    expect(state()).toEqual({ phase: 'ready', name: 'Shared masterpiece' })
    const doc = useDoc.getState()
    expect(doc.elements).toHaveLength(1)
    expect(doc.elements[0].type).toBe('rect')
    expect(doc.selectedIds).toEqual([])
    expect(localStore.setItem).not.toHaveBeenCalled()
    expect(sessionStore.setItem).not.toHaveBeenCalled()
  })

  it("'invalid' ref → bad-link without any fetch", async () => {
    await bootViewer('invalid')
    expect(state()).toEqual({ phase: 'error', kind: 'bad-link' })
    expect(fetchBlob).not.toHaveBeenCalled()
  })

  it('missing blob → not-found; dead network → network', async () => {
    fetchBlob.mockRejectedValueOnce(new ShareApiError('not-found', 'gone'))
    await bootViewer({ hash: 'A'.repeat(43), key: 'B'.repeat(22) })
    expect(state()).toEqual({ phase: 'error', kind: 'not-found' })

    fetchBlob.mockRejectedValueOnce(new ShareApiError('network', 'offline'))
    await bootViewer({ hash: 'A'.repeat(43), key: 'B'.repeat(22) })
    expect(state()).toEqual({ phase: 'error', kind: 'network' })
  })

  it('server bytes that do not match the id → corrupt (never decrypted)', async () => {
    const { hash, key } = await makeShare()
    fetchBlob.mockResolvedValue(new Uint8Array([1, 2, 3, 4]))
    await bootViewer({ hash, key })
    expect(state()).toEqual({ phase: 'error', kind: 'corrupt' })
  })

  it('a wrong key on the right blob → wrong-key', async () => {
    const share = await makeShare()
    const other = await makeShare() // different random key
    fetchBlob.mockResolvedValue(share.stored)
    await bootViewer({ hash: share.hash, key: other.key })
    expect(state()).toEqual({ phase: 'error', kind: 'wrong-key' })
  })
})

describe('saveViewerCopy', () => {
  it('persists a real document, binds the tab, and reloads without the fragment', async () => {
    const { stored, hash, key } = await makeShare()
    fetchBlob.mockResolvedValue(stored)
    await bootViewer({ hash, key })

    await saveViewerCopy()
    const index = JSON.parse(localStore.getItem(INDEX_KEY)!) as { id: string; name: string }[]
    expect(index).toHaveLength(1)
    expect(index[0].name).toBe('Shared masterpiece')
    const raw = localStore.getItem(docKey(index[0].id))
    expect(raw).toBeTruthy()
    const persisted = JSON.parse(raw!) as StoredDoc
    expect(persisted.schemaVersion).toBe(CURRENT_DOC_SCHEMA)
    expect(persisted.elements).toHaveLength(1)
    expect(persisted.selectedIds).toEqual([])
    expect(sessionStore.getItem(ACTIVE_KEY)).toBe(index[0].id)
    expect(location.replace).toHaveBeenCalledWith('/')
  })

  it('throws when nothing is staged', async () => {
    await expect(saveViewerCopy()).rejects.toThrow()
  })
})
