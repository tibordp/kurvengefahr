// Global keyboard shortcuts. Reads/acts on the document store directly so it doesn't need to
// re-subscribe on every selection change. Ignored while typing in a field. The bindings here are
// mirrored in the Help dialog + button tooltips via `./shortcuts`.
import { useEffect } from 'react'
import { useDoc } from '../store/document'
import { useTools } from '../store/tools'
import { useUI } from '../store/ui'
import { usePreview } from '../store/preview'
import { exportGcode } from '../output/export'
import { TOOL_KEYS } from './shortcuts'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // `?` opens the help/shortcuts dialog — works even mid-typing-free, always available.
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTyping(e.target)) return
        e.preventDefault()
        useUI.getState().toggleHelp()
        return
      }

      // While the Help dialog owns the screen, swallow the rest (it handles its own Esc/Tab).
      if (useUI.getState().helpOpen) return

      // ⌘/Ctrl+S — generate & download G-code (overrides the browser's save).
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void exportGcode()
        return
      }

      if (isTyping(e.target)) return

      // Space toggles preview playback (only while the preview transport is active). If a button
      // has focus, let its native Space-activation handle it instead (avoids a double-toggle).
      if (e.key === ' ' && usePreview.getState().active) {
        const el = e.target as HTMLElement | null
        if (el?.tagName === 'BUTTON' || el?.closest?.('button')) return
        e.preventDefault()
        const p = usePreview.getState()
        if (p.dist >= (p.toolpath?.total ?? 0)) p.setDist(0) // replay from start
        p.setPlaying(!p.playing)
        return
      }

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
