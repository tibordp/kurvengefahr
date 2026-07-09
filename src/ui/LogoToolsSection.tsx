// The tool sidebar's custom-tools section: one stamp-button per saved Logo tool (a monogram tile —
// clicking arms it like any drawing tool; the next canvas click stamps an element with the tool's
// source). Right-clicking a tile offers the contextual actions (rename/delete); the full library
// management (list, import/export) lives in the inspector's Preferences tab.
import { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useTools } from '../store/tools'
import { useLogoTools, type LogoTool } from '../store/logoTools'
import { confirmDialog, promptDialog } from '../store/dialogs'
import { cx, ContextMenu, MenuItem } from './primitives'

/** First letters of up to two words — the tile label ("Fern Leaf" → FL, "spiral" → S). */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

export async function renameTool(t: LogoTool): Promise<void> {
  const name = await promptDialog({ title: 'Rename tool', initial: t.name })
  if (name) useLogoTools.getState().renameTool(t.id, name)
}

export async function deleteTool(t: LogoTool): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete tool',
    message: `Delete "${t.name}"? Elements stamped with it are unaffected.`,
    confirmLabel: 'Delete',
    danger: true,
  })
  if (ok) useLogoTools.getState().removeTool(t.id)
}

export function LogoToolsSection({ buttonClass, dividerClass }: { buttonClass: string; dividerClass: string }) {
  const tool = useTools((s) => s.tool)
  const setTool = useTools((s) => s.setTool)
  const tools = useLogoTools((s) => s.tools)
  const [menu, setMenu] = useState<{ x: number; y: number; tool: LogoTool } | null>(null)

  if (tools.length === 0) return null
  return (
    <>
      <span className={dividerClass} aria-hidden />
      {tools.map((t) => {
        const armed = tool === `custom:${t.id}`
        return (
          <button
            key={t.id}
            onClick={() => setTool(`custom:${t.id}`)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, tool: t })
            }}
            title={`Custom tool: ${t.name}`}
            aria-label={`Custom tool: ${t.name}`}
            aria-pressed={armed}
            className={cx(buttonClass, armed ? 'bg-accent-solid text-white' : 'text-muted hover:bg-bg hover:text-text')}
          >
            <span className="text-[10px] font-bold tracking-wide">{monogram(t.name)}</span>
          </button>
        )
      })}
      {/* The ContextMenu clamps itself into the viewport and closes on any click. */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <MenuItem onClick={() => void renameTool(menu.tool)}>
            <Pencil size={14} /> Rename…
          </MenuItem>
          <MenuItem danger onClick={() => void deleteTool(menu.tool)}>
            <Trash2 size={14} /> Delete
          </MenuItem>
        </ContextMenu>
      )}
    </>
  )
}
