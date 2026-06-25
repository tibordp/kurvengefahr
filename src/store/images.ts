// Image blob store, backed by IndexedDB (images are too big and too binary for localStorage). The
// document model references images by a string `imageId` inside element params; the bytes live
// here. This module imports only the `idb` leaf, so it's safe to use from the vectorize Web Worker
// (which calls `getImageBlob`) as well as the main thread.
//
// All images are normalised to PNG on import (crisp edges for tracing, alpha preserved) and
// downsampled to a fixed pixel budget so a huge upload can't bloat storage or stall vectorization.

import type { DocElement } from '../core/types'
import { IMAGES_STORE, idbDelete, idbGet, idbGetAllKeys, idbPut } from './persistence/idb'

/** Max pixels (w×h) we keep; larger uploads are rescaled proportionally below this. ~4 MP. */
const MAX_PIXELS = 4_000_000

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

/** Store an externally-provided blob under `imageId` (used by container import, which re-mints ids). */
export async function putImageBlob(imageId: string, blob: Blob): Promise<void> {
  let width = 0
  let height = 0
  try {
    const bitmap = await createImageBitmap(blob)
    width = bitmap.width
    height = bitmap.height
    bitmap.close()
  } catch {
    /* unknown dims — store anyway; the element keeps its own natural dims in params */
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

/** The image ids referenced by a set of elements (via `params.imageId`). Used for export bundling
 *  and orphan GC. Generic over element type so any future image-referencing type is covered. */
export function referencedImageIds(elements: DocElement[]): string[] {
  const ids = new Set<string>()
  for (const el of elements) {
    const p = el.params as { imageId?: unknown } | null
    if (p && typeof p.imageId === 'string' && p.imageId) ids.add(p.imageId)
  }
  return [...ids]
}
