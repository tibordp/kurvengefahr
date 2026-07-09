// Content-import actions: pick a file and route it — SVG/DXF to their import dialogs, STL to a
// 3D model (wireframe) element, anything else to a raster image element (stored downsampled, sized ~100 mm
// on its longest side). Entry points are a file picker (the toolbar "Import" button + menu/palette
// "Import…") and a clipboard paste; all funnel through `importFile`. Unlike the drawing tools
// these aren't canvas modes; they're one-shot actions, not `Tool`s. New raster/model elements
// auto-generate via the generation controller.
import { useDoc } from '../store/document'
import { toast } from '../store/toast'
import { importImage, importModel } from '../store/images'
import { defaultRasterParams } from '../elements/raster'
import { defaultModelParams } from '../elements/model'
import { pickFile } from '../output/download'
import { useSvgImport } from '../store/svgImport'
import { useDxfImport } from '../store/dxfImport'

const isSvg = (f: File) => f.type === 'image/svg+xml' || /\.svg$/i.test(f.name)
const isDxf = (f: File) => /\.dxf$/i.test(f.name)
const isStl = (f: File) => f.type === 'model/stl' || /\.stl$/i.test(f.name)

/** Route a picked content file to the right importer: SVG → the SVG import dialog, anything else →
 *  a raster image element. (So dropping an SVG on the image button silently does the right thing.) */
export async function importFile(file: File): Promise<void> {
  if (isSvg(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    useSvgImport.getState().open({ bytes, name: file.name })
    return
  }
  if (isDxf(file)) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    useDxfImport.getState().open({ bytes, name: file.name })
    return
  }
  if (isStl(file)) {
    await addModelElement(file)
    return
  }
  await addImageElement(file)
}

/** Menu "Import…": pick any supported content file (vector, raster, or 3D model) and route it. */
export async function importContentFile(): Promise<void> {
  const file = await pickFile('image/svg+xml,.svg,.dxf,.stl,image/*')
  if (file) await importFile(file)
}

/** Store an STL model and add a 3D model (wireframe) element for it. */
export async function addModelElement(source: File | Blob): Promise<string | null> {
  try {
    const { modelId } = await importModel(source)
    return useDoc.getState().addElement('model', defaultModelParams(modelId), { x: 20, y: 20 })
  } catch {
    toast.error('Could not import that model (64 MB max, binary or ASCII STL).')
    return null
  }
}

/** Store an image (File or Blob — clipboard images arrive as Blobs) and add a raster element for it. */
export async function addImageElement(source: File | Blob): Promise<string | null> {
  try {
    const { imageId, width, height } = await importImage(source)
    const longest = Math.max(width, height) || 1
    const s = 100 / longest
    const tw = Math.max(1, width * s)
    const th = Math.max(1, height * s)
    return useDoc.getState().addElement('raster', defaultRasterParams(imageId, width, height, tw, th), { x: 20, y: 20 })
  } catch {
    toast.error('Could not import that image.')
    return null
  }
}

