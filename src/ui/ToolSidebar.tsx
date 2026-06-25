// Left tool palette (Figma/Illustrator-style). Vertical on desktop (a grid column), a horizontal
// strip above the canvas on mobile. Selecting a tool puts the canvas into that drawing mode; the
// trailing "Import image" entry is an action (opens a file picker), not a mode — so it's a plain
// button, never a pressed toggle.
import { Image as ImageIcon } from 'lucide-react'
import { useTools } from '../store/tools'
import { importImageElement } from '../canvas/importImage'
import { TOOLS } from './shortcuts'
import { cx } from './primitives'

const buttonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/45'

export function ToolSidebar() {
  const tool = useTools((s) => s.tool)
  const setTool = useTools((s) => s.setTool)
  return (
    <nav
      aria-label="Tools"
      className="flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-1.5 md:min-h-0 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r"
    >
      {TOOLS.map(({ tool: t, icon: Icon, label, key }) => (
        <button
          key={t}
          onClick={() => setTool(t)}
          title={`${label} (${key})`}
          aria-label={label}
          aria-pressed={tool === t}
          className={cx(buttonClass, tool === t ? 'bg-accent-solid text-white' : 'text-muted hover:bg-bg hover:text-text')}
        >
          <Icon size={17} />
        </button>
      ))}

      {/* Separator between drawing modes and one-shot insert actions: a vertical divider in the
          mobile row, a horizontal rule in the desktop column. */}
      <span className="w-px shrink-0 self-stretch bg-border md:h-px md:w-full" aria-hidden />

      <button
        onClick={() => void importImageElement()}
        title="Import image"
        aria-label="Import image"
        className={cx(buttonClass, 'text-muted hover:bg-bg hover:text-text')}
      >
        <ImageIcon size={17} />
      </button>
    </nav>
  )
}
