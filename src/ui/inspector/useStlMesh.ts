// Loads a model element's STL (by modelId, from the IndexedDB blob store) as a decimated,
// bbox-centered triangle soup for the inspector's orbit preview. The parse is a synchronous
// main-thread WASM call (linear scan, ~tens of ms for a large STL) cached per modelId — blobs are
// immutable, so one hitch per model per session. Returns null until ready or if the blob is
// missing/unparseable — callers show a placeholder.
import { useEffect, useState } from 'react'
import { getImageBlob } from '../../store/images'
import { stl_mesh_preview } from '../../core/wasm'

export interface StlMesh {
  /** Flat triangle positions (9 f32 per triangle), centered on the full mesh's bbox center. */
  positions: Float32Array
  /** Full-mesh bounding radius — the same framing measure the Rust depth render uses. */
  radius: number
  /** Undecimated triangle count (for the "N triangles" caption). */
  totalTris: number
}

/** Triangle budget for the preview: painter-sorted 2D-canvas flat shading stays ~60 fps here. */
export const PREVIEW_MAX_TRIS = 6000

const meshCache = new Map<string, Promise<StlMesh | null>>()

function loadMesh(modelId: string): Promise<StlMesh | null> {
  let p = meshCache.get(modelId)
  if (!p) {
    p = (async () => {
      const blob = await getImageBlob(modelId)
      if (!blob) return null
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const res = stl_mesh_preview(bytes, PREVIEW_MAX_TRIS)
        const mesh: StlMesh = {
          positions: res.positions,
          radius: res.radius,
          totalTris: res.total_tris,
        }
        res.free()
        return mesh
      } catch {
        return null // unparseable blob — placeholder
      }
    })()
    meshCache.set(modelId, p)
  }
  return p
}

export function useStlMesh(modelId: string): StlMesh | null {
  const [mesh, setMesh] = useState<StlMesh | null>(null)

  useEffect(() => {
    let cancelled = false
    setMesh(null)
    if (!modelId) return
    void loadMesh(modelId).then((m) => {
      if (!cancelled) setMesh(m)
    })
    return () => {
      cancelled = true
    }
  }, [modelId])

  return mesh
}
