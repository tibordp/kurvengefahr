// The `.kgz` container: export → parse round-trip and the never-throw contract. Runs in node —
// Blob and fflate are environment-agnostic.
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import '../elements/shapes'
import { documentFile, loadStoredDoc } from '../store/persistence/schema'
import { exportDocumentContainer, parseDocumentContainer } from './container'

async function makeDocFile() {
  const loaded = loadStoredDoc({
    name: 'Container doc',
    elements: [{ id: 'r1', type: 'rect', params: { width: 10, height: 10 } }],
  })
  if (loaded.status !== 'ok') throw new Error('fixture doc failed to load')
  return documentFile(loaded.value)
}

describe('.kgz container', () => {
  it('round-trips the document and its content blobs', async () => {
    const docFile = await makeDocFile()
    const png = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    const stl = new Blob([new Uint8Array([9, 8, 7])], { type: 'model/stl' })
    const kgz = await exportDocumentContainer(docFile, [
      { imageId: 'img-1', blob: png },
      { imageId: 'model-1', blob: stl },
    ])

    const out = await parseDocumentContainer(kgz)
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.value.name).toBe('Container doc')
    expect(out.value.snapshot.elements.map((e) => e.id)).toEqual(['r1'])

    const byId = new Map(out.value.images.map((i) => [i.imageId, i.blob]))
    expect([...byId.keys()].sort()).toEqual(['img-1', 'model-1'])
    expect(byId.get('img-1')!.type).toBe('image/png') // mime recovered from the extension
    expect(byId.get('model-1')!.type).toBe('model/stl')
    expect(new Uint8Array(await byId.get('img-1')!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(new Uint8Array(await byId.get('model-1')!.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('keeps a blob with an unknown extension as octet-stream instead of dropping it', async () => {
    const docFile = await makeDocFile()
    const weird = new Blob([new Uint8Array([5])], { type: 'application/x-weird' })
    const out = await parseDocumentContainer(await exportDocumentContainer(docFile, [{ imageId: 'w', blob: weird }]))
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.value.images).toHaveLength(1)
    expect(out.value.images[0].blob.type).toBe('application/octet-stream')
  })

  it('rejects non-zip, incomplete, and truncated blobs without throwing', async () => {
    expect((await parseDocumentContainer(new Blob(['just text']))).status).toBe('invalid')
    expect((await parseDocumentContainer(new Blob([]))).status).toBe('invalid')
    // A real zip that is missing document.json.
    const zip = zipSync({ 'other.txt': strToU8('hi') })
    expect((await parseDocumentContainer(new Blob([zip]))).status).toBe('invalid')
    // Zip magic followed by garbage.
    const truncated = new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff])])
    expect((await parseDocumentContainer(truncated)).status).toBe('invalid')
  })
})
