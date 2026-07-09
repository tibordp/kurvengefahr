// Left tool palette (Figma/Illustrator-style). Vertical on desktop (a grid column), a horizontal
// strip above the canvas on mobile. Tools are grouped by purpose (a divider between groups; see
// TOOL_GROUPS). Selecting a tool puts the canvas into that drawing mode; the trailing "Import"
// entry is an action (opens a file picker for image/SVG/DXF/STL), not a mode — so it's a plain button,
// never a pressed toggle.
import { Fragment } from 'react'
import { Image as ImageIcon } from 'lucide-react'
import { useTools } from '../store/tools'
import { importContentFile } from '../canvas/importImage'
import { TOOL_GROUPS } from './shortcuts'
import { LogoToolsSection } from './LogoToolsSection'
import { cx } from './primitives'

const buttonClass =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/45'

// A vertical divider in the mobile row, a horizontal rule in the desktop column.
const dividerClass = 'w-px shrink-0 self-stretch bg-border md:h-px md:w-full'

export function ToolSidebar() {
  const tool = useTools((s) => s.tool)
  const setTool = useTools((s) => s.setTool)
  return (
    <nav
      aria-label="Tools"
      className="flex min-w-0 shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-1.5 md:min-h-0 md:flex-col md:overflow-x-visible md:overflow-y-auto md:border-b-0 md:border-r"
      // Custom tool tiles have their own right-click actions; suppress the browser menu on the
      // rest of the palette so right-click behaves consistently across it.
      onContextMenu={(e) => e.preventDefault()}
    >
      {TOOL_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <span className={dividerClass} aria-hidden />}
          {group.map(({ tool: t, icon: Icon, label, key }) => (
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
        </Fragment>
      ))}

      {/* Saved Logo tools (custom stamps) + their management menu. */}
      <LogoToolsSection buttonClass={buttonClass} dividerClass={dividerClass} />

      {/* Separator between drawing modes and the one-shot insert action. */}
      <span className={dividerClass} aria-hidden />

      <button
        onClick={() => void importContentFile()}
        title="Import file (image, SVG, DXF, or STL)"
        aria-label="Import file (image, SVG, DXF, or STL)"
        className={cx(buttonClass, 'text-muted hover:bg-bg hover:text-text')}
      >
        <ImageIcon size={17} />
      </button>
    </nav>
  )
}
