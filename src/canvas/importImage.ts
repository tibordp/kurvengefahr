// "Add an image" actions: store the (downsampled) blob and add a raster element sized to the image's
// aspect (~100 mm on its longest side). Two entry points — a file picker (toolbar button) and a
// clipboard paste — both funnel through `addImageElement`. Unlike the drawing tools these aren't
// canvas modes; they're one-shot actions, not `Tool`s. The new element auto-vectorizes via the
// generation controller.
import { useDoc } from '../store/document'
import { importImage } from '../store/images'
import { defaultRasterParams } from '../elements/raster'
import { pickImageFile } from '../output/download'

/** Store an image (File or Blob — clipboard images arrive as Blobs) and add a raster element for it. */
export async function addImageElement(source: File | Blob): Promise<void> {
  try {
    const { imageId, width, height } = await importImage(source)
    const longest = Math.max(width, height) || 1
    const s = 100 / longest
    const tw = Math.max(1, width * s)
    const th = Math.max(1, height * s)
    useDoc.getState().addElement('raster', defaultRasterParams(imageId, width, height, tw, th), { x: 20, y: 20 })
  } catch {
    alert('Could not import that image.')
  }
}

export async function importImageElement(): Promise<void> {
  const file = await pickImageFile()
  if (!file) return
  await addImageElement(file)
}
