// Content blob store, backed by IndexedDB (blobs are too big and too binary for localStorage). The
// document model references blobs by a string id inside element params — `imageId` for raster
// images, `modelId` for STL models; the bytes live here. This module imports only the `idb` leaf,
// so it's safe to use from the generation Web Workers (which call `getImageBlob`) as well as the
// main thread.
//
// Images are normalised to PNG on import (crisp edges for tracing, alpha preserved) and
// downsampled to a fixed pixel budget so a huge upload can't bloat storage or stall vectorization.
// Models are stored as their raw bytes (the STL is the authoritative input), size-capped.

import type { DocElement } from '../core/types'
import { IMAGES_STORE, idbDelete, idbGet, idbGetAllKeys, idbPut } from './persistence/idb'

/** Max pixels (w×h) we keep; larger uploads are rescaled proportionally below this. ~4 MP. */
const MAX_PIXELS = 4_000_000

/** Max STL upload we accept (binary ~50 B/triangle → ~1.3 M triangles). */
const MAX_MODEL_BYTES = 64 * 1024 * 1024

/** Every element-params key that references a stored blob. GC, undo liveness, `.kgz` bundling and
 *  id re-minting all pivot on this list — extend it when a new blob-referencing param appears. */
export const BLOB_PARAM_KEYS = ['imageId', 'modelId'] as const

interface StoredImage {
  id: string
  mime: string
  blob: Blob
  width: number
  height: number
}

/** Decode `bitmap` onto a canvas at `w×h` and encode PNG. Works on the main thread and in workers. */
async function encodePng(bitmap: ImageBitmap, w: number, h: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(bitmap, 0, 0, w, h)
    return canvas.convertToBlob({ type: 'image/png' })
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable')
  ctx.drawImage(bitmap, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
}

/**
 * Decode, downsample (if over the pixel budget), re-encode as PNG, and store. Returns a fresh
 * `imageId` and the stored (post-downsample) dimensions so the element can size itself.
 */
export async function importImage(file: File | Blob): Promise<{ imageId: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  try {
    const nw = bitmap.width
    const nh = bitmap.height
    let w = nw
    let h = nh
    const px = nw * nh
    if (px > MAX_PIXELS) {
      const scale = Math.sqrt(MAX_PIXELS / px)
      w = Math.max(1, Math.round(nw * scale))
      h = Math.max(1, Math.round(nh * scale))
    }
    const blob = await encodePng(bitmap, w, h)
    const imageId = crypto.randomUUID()
    await idbPut(IMAGES_STORE, { id: imageId, mime: 'image/png', blob, width: w, height: h } satisfies StoredImage)
    return { imageId, width: w, height: h }
  } finally {
    bitmap.close()
  }
}

/** The raw image blob, or null if missing / IndexedDB is unavailable. Safe to call in a worker. */
export async function getImageBlob(imageId: string): Promise<Blob | null> {
  try {
    const rec = await idbGet<StoredImage>(IMAGES_STORE, imageId)
    return rec?.blob ?? null
  } catch {
    return null
  }
}

/** Store an STL model's raw bytes. Returns a fresh `modelId`; rejects over-budget uploads (the
 *  caller toasts). No normalization — unlike images, the model bytes are kept verbatim. */
export async function importModel(file: File | Blob): Promise<{ modelId: string }> {
  if (file.size > MAX_MODEL_BYTES) throw new Error('model too large')
  const blob = file.type === 'model/stl' ? file : new Blob([file], { type: 'model/stl' })
  const modelId = crypto.randomUUID()
  await idbPut(IMAGES_STORE, { id: modelId, mime: 'model/stl', blob, width: 0, height: 0 } satisfies StoredImage)
  return { modelId }
}

/** Store an externally-provided blob under `imageId` (used by container import, which re-mints ids). */
export async function putImageBlob(imageId: string, blob: Blob): Promise<void> {
  let width = 0
  let height = 0
  if (blob.type.startsWith('image/')) {
    try {
      const bitmap = await createImageBitmap(blob)
      width = bitmap.width
      height = bitmap.height
      bitmap.close()
    } catch {
      /* unknown dims — store anyway; the element keeps its own natural dims in params */
    }
  }
  await idbPut(IMAGES_STORE, { id: imageId, mime: blob.type || 'image/png', blob, width, height } satisfies StoredImage)
}

export async function deleteImage(imageId: string): Promise<void> {
  try {
    await idbDelete(IMAGES_STORE, imageId)
  } catch {
    /* ignore */
  }
}

export async function listImageIds(): Promise<string[]> {
  try {
    return await idbGetAllKeys(IMAGES_STORE)
  } catch {
    return []
  }
}

/** The blob ids referenced by a set of elements (via any `BLOB_PARAM_KEYS` param). Used for export
 *  bundling and orphan GC. Generic over element type so any blob-referencing type is covered. */
export function referencedImageIds(elements: DocElement[]): string[] {
  const ids = new Set<string>()
  for (const el of elements) {
    const p = el.params as Record<string, unknown> | null
    if (!p) continue
    for (const key of BLOB_PARAM_KEYS) {
      const v = p[key]
      if (typeof v === 'string' && v) ids.add(v)
    }
  }
  return [...ids]
}
