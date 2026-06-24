// Left tool palette (Figma/Illustrator-style). Vertical on desktop (a grid column), a horizontal
// strip above the canvas on mobile. Selecting a tool puts the canvas into that drawing mode.
import { useTools } from '../store/tools'
import { TOOLS } from './shortcuts'
import { cx } from './primitives'

export function ToolSidebar() {
  const tool = useTools((s) => s.tool)
  const setTool = useTools((s) => s.setTool)
  return (
    <nav
      aria-label="Tools"
      className="flex shrink-0 gap-1 border-b border-border bg-surface p-1.5 md:flex-col md:border-b-0 md:border-r"
    >
      {TOOLS.map(({ tool: t, icon: Icon, label, key }) => (
        <button
          key={t}
          onClick={() => setTool(t)}
          title={`${label} (${key})`}
          aria-label={label}
          aria-pressed={tool === t}
          className={cx(
            'flex h-9 w-9 items-center justify-center rounded-md outline-none transition-colors',
            'focus-visible:ring-2 focus-visible:ring-accent/45',
            tool === t ? 'bg-accent-solid text-white' : 'text-muted hover:bg-bg hover:text-text',
          )}
        >
          <Icon size={17} />
        </button>
      ))}
    </nav>
  )
}
