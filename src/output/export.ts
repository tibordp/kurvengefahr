// The "Generate G-code" action, factored out of the toolbar so the keyboard shortcut (⌘/Ctrl+S)
// and the button share one code path. Reads the authoritative document straight from the store.
import { runPipeline } from '../core/pipeline'
import { useDoc } from '../store/document'
import { downloadSink } from './sink'

/** Build G-code for the whole page and hand it to the download sink. No-op on an empty document. */
export async function exportGcode(): Promise<void> {
  const { elements, profile, fiducial } = useDoc.getState()
  if (elements.length === 0) return
  const gcode = await runPipeline(elements, profile, [], fiducial)
  await downloadSink.send('kurvengefahr.gcode', gcode)
}
