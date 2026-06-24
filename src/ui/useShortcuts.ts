// Global keyboard shortcuts. Reads/acts on the document store directly so it doesn't need to
// re-subscribe on every selection change. Ignored while typing in a field.
import { useEffect } from 'react'
import { useDoc } from '../store/document'
import { useTools, type Tool } from '../store/tools'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

// Single-key tool selection (no modifier).
const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  t: 'handwriting',
  l: 'line',
  r: 'rect',
  o: 'ellipse',
  p: 'pen',
  f: 'freehand',
  x: 'fiducial',
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return

      // Tool switching — plain letters, no modifiers (so Ctrl/Cmd shortcuts pass through).
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = TOOL_KEYS[e.key.toLowerCase()]
        if (t) {
          e.preventDefault()
          useTools.getState().setTool(t)
          return
        }
      }

      const { selectedIds, removeSelected, duplicateSelected, nudge, clearSelection } = useDoc.getState()
      const NUDGE: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!selectedIds.length) return
        e.preventDefault()
        removeSelected()
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        if (!selectedIds.length) return
        e.preventDefault() // browser's add-bookmark
        duplicateSelected()
      } else if (NUDGE[e.key]) {
        if (!selectedIds.length) return
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1 // mm
        const [dx, dy] = NUDGE[e.key]
        nudge(dx * step, dy * step)
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
