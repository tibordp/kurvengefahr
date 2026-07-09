// The Preferences tab: app-wide (not per-document) settings — appearance, and the Logo tool
// library (tools are device-global, like machine profiles, so they manage from here rather than
// any one document's panels).
import { Download, Moon, Monitor, Pencil, Sun, Trash2, Upload } from 'lucide-react'
import { useTheme, type Theme } from '../../store/theme'
import { useLogoTools } from '../../store/logoTools'
import { parseToolsFile, toolsFile } from '../../store/persistence/schema'
import { downloadJson, pickJsonFile } from '../../output/download'
import { deleteTool, monogram, renameTool } from '../LogoToolsSection'
import { Button, Field, IconButton, SectionTitle, cx } from '../primitives'

// App-wide preferences (not document state) — currently just appearance. Lives in its own inspector
// tab so it's discoverable without crowding the per-element / per-machine panels.
const THEME_OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

/** The Logo tool library: rename/delete saved tools, import/export the list as a JSON file.
 *  Mirrors the machine-profile controls; stamped elements are copies, so nothing here touches
 *  documents. */
function LogoToolsPrefs() {
  const tools = useLogoTools((s) => s.tools)

  const importTools = async () => {
    try {
      const raw = await pickJsonFile()
      if (raw == null) return
      const res = parseToolsFile(raw)
      if (res.status === 'ok') useLogoTools.getState().importTools(res.value)
      else if (res.status === 'unsupported') alert(`Can't import — ${res.message}. Try updating the app.`)
      else alert('That file is not a valid Kurvengefahr tools file.')
    } catch {
      alert('Could not read that file.')
    }
  }
  const exportTools = () => downloadJson('kurvengefahr-tools', toolsFile(useLogoTools.getState().tools))

  return (
    <>
      <SectionTitle title="Saved Logo programs that appear as stamps in the tool sidebar. Shared across all documents on this device.">
        Logo tools
      </SectionTitle>
      {tools.length === 0 ? (
        <p className="text-xs text-muted">
          No tools yet. Select a Logo element and use “Save as tool”.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {tools.map((t) => (
            <li key={t.id} className="group flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-bg">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-[10px] font-bold text-muted">
                {monogram(t.name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
              <IconButton aria-label={`Rename ${t.name}`} title="Rename" className="h-7 w-7" onClick={() => renameTool(t)}>
                <Pencil size={14} />
              </IconButton>
              <IconButton aria-label={`Delete ${t.name}`} title="Delete" className="h-7 w-7" onClick={() => deleteTool(t)}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex gap-2">
        <Button className="min-w-0 flex-1" title="Import tools from a JSON file (merged in)" onClick={() => void importTools()}>
          <Upload size={14} /> Import…
        </Button>
        {tools.length > 0 && (
          <Button className="min-w-0 flex-1" title="Export all tools as a JSON file" onClick={exportTools}>
            <Download size={14} /> Export
          </Button>
        )}
      </div>
    </>
  )
}

export function PreferencesSection() {
  const theme = useTheme((s) => s.theme)
  const setTheme = useTheme((s) => s.setTheme)
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Field label="Theme" full>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-0.5 rounded-md border border-border bg-bg p-0.5"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              title={`${label} theme`}
              onClick={() => setTheme(value)}
              className={cx(
                'flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium',
                'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/45',
                theme === value
                  ? 'bg-surface text-text shadow-panel'
                  : 'text-muted hover:text-text',
              )}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </Field>
      <LogoToolsPrefs />
    </>
  )
}
