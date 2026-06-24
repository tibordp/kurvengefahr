// Left tool palette (Figma/Illustrator-style). Vertical on desktop (a grid column), a horizontal
// strip above the canvas on mobile. Selecting a tool puts the canvas into that drawing mode.
import { MousePointer2, Type, Minus, Square, Circle, PenTool, Pencil, type LucideIcon } from 'lucide-react'
import { useTools, type Tool } from '../store/tools'
import { cx } from './primitives'

const TOOLS: { tool: Tool; icon: LucideIcon; label: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { tool: 'handwriting', icon: Type, label: 'Handwriting', key: 'T' },
  { tool: 'line', icon: Minus, label: 'Line', key: 'L' },
  { tool: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { tool: 'pen', icon: PenTool, label: 'Pen (Bézier)', key: 'P' },
  { tool: 'freehand', icon: Pencil, label: 'Freehand', key: 'F' },
]

export function ToolSidebar() {
  const tool = useTools((s) => s.tool)
  const setTool = useTools((s) => s.setTool)
  return (
    <nav className="flex shrink-0 gap-1 border-b border-border bg-surface p-1.5 md:flex-col md:border-b-0 md:border-r">
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
