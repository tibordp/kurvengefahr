// The "Generate G-code" action, factored out of the toolbar so the keyboard shortcut (⌘/Ctrl+S)
// and the button share one code path. Reads the authoritative document straight from the store.
import { runPipeline } from '../core/pipeline'
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { downloadSink } from './sink'
import { plot } from './plot'

/** Build G-code for the whole page and hand it to the download sink. No-op on an empty document. */
export async function exportGcode(): Promise<void> {
  const { elements, profile, fiducial } = useDoc.getState()
  if (elements.length === 0) return
  const gcode = await runPipeline(elements, profile, [], fiducial)
  await downloadSink.send('kurvengefahr.gcode', gcode)
}

/** Build the same G-code and send it straight to the profile's bound physical device. No-op on an
 *  empty document or an unbound profile. Throws a BridgeError (mapped to a toast by the caller). */
export async function plotGcode(): Promise<void> {
  const { elements, profile, fiducial } = useDoc.getState()
  if (elements.length === 0 || !profile.device) return
  const gcode = await runPipeline(elements, profile, [], fiducial)
  const name = (useDocuments.getState().activeName || 'kurvengefahr').replace(/\s+/g, '-')
  await plot(profile, gcode, `${name}.gcode`)
}
