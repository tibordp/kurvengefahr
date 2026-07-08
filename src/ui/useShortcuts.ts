// Global keyboard shortcuts. Reads/acts on the document store directly so it doesn't need to
// re-subscribe on every selection change. Ignored while typing in a field. The bindings here are
// mirrored in the Help dialog + button tooltips via `./shortcuts`.
import { useEffect } from 'react'
import { useDoc } from '../store/document'
import { useTools } from '../store/tools'
import { useUI } from '../store/ui'
import { usePreview } from '../store/preview'
import { exportGcode } from '../output/export'
import { undo, redo } from '../store/history'
import { deleteSelectedNodes, clearNodeSelection } from '../canvas/nodeSelection'
import { useCommandPalette } from '../store/commandPalette'
import { useViewport } from '../store/viewport'
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

      // ⌘/Ctrl+K — command palette (works even from a focused field).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        useCommandPalette.getState().toggle()
        return
      }

      // ⌘/Ctrl+S — generate & download G-code (overrides the browser's save).
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        void exportGcode()
        return
      }

      if (isTyping(e.target)) return

      // Escape snaps out of the read-only preview back to editing (handled before tool/canvas Escape
      // uses, which are no-ops during preview anyway). Not in driven mode: a live plot session owns
      // the overlay — it exits when the plot ends, not on a stray keypress.
      if (e.key === 'Escape' && usePreview.getState().active && !usePreview.getState().driven) {
        e.preventDefault()
        usePreview.getState().exit()
        return
      }

      // Undo / redo. After the typing guard, so a focused text field keeps native text-undo (the
      // field's own focus-session still coalesces into one app-level step on blur).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }

      // Select all elements.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        const { elements, selectMany } = useDoc.getState()
        selectMany(elements.map((el) => el.id))
        return
      }

      // Copy / cut / paste run through the native clipboard events (App's `useSystemClipboard`) — the
      // only place with synchronous system-clipboard access — so they hit the real OS clipboard and
      // work across documents, tabs and windows. Nothing to do here.

      // Space toggles preview playback (only while the preview transport is active — not while a
      // live plot session drives the playhead). If a button has focus, let its native
      // Space-activation handle it instead (avoids a double-toggle).
      if (e.key === ' ' && usePreview.getState().active && !usePreview.getState().driven) {
        const el = e.target as HTMLElement | null
        if (el?.tagName === 'BUTTON' || el?.closest?.('button')) return
        e.preventDefault()
        const p = usePreview.getState()
        if (p.dist >= (p.toolpath?.total ?? 0)) p.setDist(0) // replay from start
        p.setPlaying(!p.playing)
        return
      }

      // Fit view: Shift+1 (everything) / Shift+2 (selection).
      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault()
        useViewport.getState().requestFit('all')
        return
      }
      if (e.shiftKey && e.code === 'Digit2') {
        e.preventDefault()
        useViewport.getState().requestFit('selection')
        return
      }

      // Flip the selection: Shift+H (horizontal) / Shift+V (vertical). Before tool switching, so
      // Shift+V doesn't fall through to the Select tool.
      if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'H' || e.key === 'V')) {
        const { selectedIds, flipSelected } = useDoc.getState()
        if (!selectedIds.length) return
        e.preventDefault()
        flipSelected(e.key === 'H' ? 'x' : 'y')
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
        // Selected path nodes take priority: delete the nodes, not the whole element.
        if (deleteSelectedNodes()) {
          e.preventDefault()
          return
        }
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
        // Esc clears the node selection first (stay in node editing); a second Esc deselects.
        if (!clearNodeSelection()) clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
