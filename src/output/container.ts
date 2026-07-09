// The `.kgz` document container: a zip bundling the document JSON (`document.json`, the same
// envelope `documentFile()` produces) plus every referenced content blob under
// `images/<blobId>.<ext>` — `.png` for raster images, `.stl` for 3D models (one shared
// directory; the ids are UUIDs). This is the *only* document file format — binary blobs can't ride
// along in plain JSON, and the app has no legacy documents to stay compatible with. The blob's
// mime picks the extension on export and is recovered from it on parse; it also picks the
// compression: PNGs are already compressed (stored, level 0), everything else deflates.
import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from 'fflate'
import { parseDocumentFile, type DocSnapshot, type Outcome } from '../store/persistence/schema'

export interface ContainerImage {
  imageId: string
  blob: Blob
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04"

const EXT_BY_MIME: Record<string, string> = { 'image/png': 'png', 'model/stl': 'stl' }
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', stl: 'model/stl' }

/** Build a `.kgz` Blob from a `documentFile()` envelope and its referenced content blobs. */
export async function exportDocumentContainer(docFile: unknown, images: ContainerImage[]): Promise<Blob> {
  const files: Zippable = {}
  files['document.json'] = [strToU8(JSON.stringify(docFile)), { level: 6 }]
  for (const img of images) {
    const bytes = new Uint8Array(await img.blob.arrayBuffer())
    const ext = EXT_BY_MIME[img.blob.type] ?? 'bin'
    files[`images/${img.imageId}.${ext}`] = [bytes, { level: ext === 'png' ? 0 : 6 }]
  }
  const zipped = zipSync(files)
  return new Blob([zipped], { type: 'application/zip' })
}

/** Parse a `.kgz` container → document snapshot + name + content blobs. Total — never throws. */
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
      const name = path.slice('images/'.length)
      const imageId = name.replace(/\.[^.]+$/, '')
      const ext = name.slice(imageId.length + 1).toLowerCase()
      // Unknown extensions still import (octet-stream) rather than dropping the blob.
      const type = MIME_BY_EXT[ext] ?? 'application/octet-stream'
      if (imageId) images.push({ imageId, blob: new Blob([data], { type }) })
    }
    return { status: 'ok', value: { name: docRes.value.name, snapshot: docRes.value.snapshot, images } }
  } catch (e) {
    return { status: 'invalid', message: String(e) }
  }
}
