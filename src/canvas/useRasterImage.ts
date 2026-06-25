// Loads a raster element's source image (by imageId, from the IndexedDB blob store) as an
// ImageBitmap for the canvas to draw faintly under the traced strokes. Decodes off the main render
// path, memoized per imageId, and closes the bitmap on change/unmount. Returns null until ready (or
// if the blob is missing) — callers must not render a Konva <Image> until it's non-null.
import { useEffect, useState } from 'react'
import { getImageBlob } from '../store/images'

export function useRasterImage(imageId: string): ImageBitmap | null {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)

  useEffect(() => {
    let cancelled = false
    let current: ImageBitmap | null = null
    setBitmap(null)
    if (!imageId) return
    void (async () => {
      const blob = await getImageBlob(imageId)
      if (cancelled || !blob) return
      try {
        const bmp = await createImageBitmap(blob)
        if (cancelled) {
          bmp.close()
          return
        }
        current = bmp
        setBitmap(bmp)
      } catch {
        /* undecodable blob — leave null (placeholder) */
      }
    })()
    return () => {
      cancelled = true
      current?.close()
    }
  }, [imageId])

  return bitmap
}
