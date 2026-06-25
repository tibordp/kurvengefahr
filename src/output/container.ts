// The `.kgz` document container: a zip bundling the document JSON (`document.json`, the same
// envelope `documentFile()` produces) plus every referenced image blob under `images/<imageId>.png`.
// This is the *only* document file format — raster images can't ride along in plain JSON, and the
// app has no legacy documents to stay compatible with. PNGs are already compressed, so they're
// stored (level 0); the JSON is deflated.
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'
import { parseDocumentFile, type DocSnapshot, type Outcome } from '../store/persistence/schema'

export interface ContainerImage {
  imageId: string
  blob: Blob
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04"

/** Build a `.kgz` Blob from a `documentFile()` envelope and its referenced image blobs. */
export async function exportDocumentContainer(docFile: unknown, images: ContainerImage[]): Promise<Blob> {
  const files: Zippable = {}
  files['document.json'] = [strToU8(JSON.stringify(docFile)), { level: 6 }]
  for (const img of images) {
    const bytes = new Uint8Array(await img.blob.arrayBuffer())
    files[`images/${img.imageId}.png`] = [bytes, { level: 0 }]
  }
  const zipped = zipSync(files)
  return new Blob([zipped], { type: 'application/zip' })
}

/** Parse a `.kgz` container → document snapshot + name + image blobs. Total — never throws. */
export async function parseDocumentContainer(
  file: Blob,
): Promise<Outcome<{ name: string; snapshot: DocSnapshot; images: ContainerImage[] }>> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length < 4 || ZIP_MAGIC.some((b, i) => bytes[i] !== b))
      return { status: 'invalid', message: 'not a Kurvengefahr container' }

    const entries = unzipSync(bytes)
    const docBytes = entries['document.json']
    if (!docBytes) return { status: 'invalid', message: 'container missing document.json' }

    const docRes = parseDocumentFile(JSON.parse(strFromU8(docBytes)))
    if (docRes.status !== 'ok') return docRes

    const images: ContainerImage[] = []
    for (const [path, data] of Object.entries(entries)) {
      if (!path.startsWith('images/')) continue
      const imageId = path.slice('images/'.length).replace(/\.[^.]+$/, '')
      if (imageId) images.push({ imageId, blob: new Blob([data], { type: 'image/png' }) })
    }
    return { status: 'ok', value: { name: docRes.value.name, snapshot: docRes.value.snapshot, images } }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}
