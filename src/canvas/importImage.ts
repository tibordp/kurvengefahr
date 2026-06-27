// "Add an image" actions: store the (downsampled) blob and add a raster element sized to the image's
// aspect (~100 mm on its longest side). Two entry points — a file picker (toolbar button) and a
// clipboard paste — both funnel through `addImageElement`. Unlike the drawing tools these aren't
// canvas modes; they're one-shot actions, not `Tool`s. The new element auto-vectorizes via the
// generation controller.
import { useDoc } from '../store/document'
import { importImage } from '../store/images'
import { defaultRasterParams } from '../elements/raster'
import { pickImageFile, pickFile } from '../output/download'
import { useSvgImport } from '../store/svgImport'

const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
const isDxf = (f: File) => /\.dxf$/i.test(f.name)

/** Route a picked content file to the right importer: SVG → the SVG import dialog, anything else →
 *  a raster image element. (So dropping an SVG on the image button silently does the right thing.) */
export async function importFile(file: File): Promise<void> {
  if (isSvg(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    useSvgImport.getState().open({ bytes, name: file.name })
    return
  }
  if (isDxf(file)) {
    alert('DXF import is coming soon.')
    return
  }
  await addImageElement(file)
}

/** Menu "Import…": pick any supported content file (vector or raster) and route it. */
export async function importContentFile(): Promise<void> {
  const file = await pickFile('image/svg+xml,.svg,.dxf,image/*')
  if (file) await importFile(file)
}

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

/** Toolbar "image" button: pick an image — but an SVG silently diverts to the SVG importer. */
export async function importImageElement(): Promise<void> {
  const file = await pickImageFile()
  if (file) await importFile(file)
}
