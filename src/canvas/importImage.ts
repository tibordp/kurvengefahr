// "Add an image" action: pick a file, store the (downsampled) blob, and add a raster element sized
// to the image's aspect (~100 mm on its longest side). Unlike the drawing tools this isn't a canvas
// mode — the file picker is the interaction — so it's a one-shot action, not a `Tool`. The new
// element auto-vectorizes via the generation controller.
import { useDoc } from '../store/document'
import { importImage } from '../store/images'
import { defaultRasterParams } from '../elements/raster'
import { pickImageFile } from '../output/download'

export async function importImageElement(): Promise<void> {
  const file = await pickImageFile()
  if (!file) return
  try {
    const { imageId, width, height } = await importImage(file)
    const longest = Math.max(width, height) || 1
    const s = 100 / longest
    const tw = Math.max(1, width * s)
    const th = Math.max(1, height * s)
    useDoc.getState().addElement('raster', defaultRasterParams(imageId, width, height, tw, th), { x: 20, y: 20 })
  } catch {
    alert('Could not import that image.')
  }
}
