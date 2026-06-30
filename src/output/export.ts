// The "Generate G-code" action, factored out of the toolbar so the keyboard shortcut (⌘/Ctrl+S)
// and the button share one code path. Reads the authoritative document straight from the store.
import { runPipeline } from '../core/pipeline'
import { validateProfile } from '../core/profileValidation'
import { useDoc } from '../store/document'
import { useDocuments } from '../store/documents'
import { toast } from '../store/toast'
import { downloadSink } from './sink'
import { plot } from './plot'

/** Build G-code for the whole page and hand it to the download sink. No-op on an empty document.
 *  Refuses (with a toast) when the machine profile is invalid — the UI also disables the action. */
export async function exportGcode(): Promise<void> {
  const { elements, profile, fiducial } = useDoc.getState()
  if (elements.length === 0) return
  if (validateProfile(profile).length) {
    toast.error('Fix the machine profile before generating G-code.')
    return
  }
  const gcode = await runPipeline(elements, profile, [], fiducial)
  await downloadSink.send('kurvengefahr.gcode', gcode)
}

/** Build the same G-code and send it straight to the profile's bound physical device. No-op on an
 *  empty document or an unbound profile. Throws a BridgeError (mapped to a toast by the caller). */
export async function plotGcode(): Promise<void> {
  const { elements, profile, fiducial } = useDoc.getState()
  if (elements.length === 0 || !profile.device) return
  if (validateProfile(profile).length) {
    toast.error('Fix the machine profile before plotting.')
    return
  }
  const gcode = await runPipeline(elements, profile, [], fiducial)
  const name = (useDocuments.getState().activeName || 'kurvengefahr').replace(/\s+/g, '-')
  await plot(profile, gcode, `${name}.gcode`)
}
