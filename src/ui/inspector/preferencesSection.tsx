// The Preferences tab: app-wide appearance (theme) settings.
import { Sun, Moon, Monitor } from 'lucide-react'
import { useTheme, type Theme } from '../../store/theme'
import { Field, SectionTitle, cx } from '../primitives'

// App-wide preferences (not document state) — currently just appearance. Lives in its own inspector
// tab so it's discoverable without crowding the per-element / per-machine panels.
const THEME_OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

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
    </>
  )
}
