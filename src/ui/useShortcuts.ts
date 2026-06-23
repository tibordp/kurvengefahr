// Global keyboard shortcuts. Reads/acts on the document store directly so it doesn't need to
// re-subscribe on every selection change. Ignored while typing in a field.
import { useEffect } from 'react'
import { useDoc } from '../store/document'

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      const { selectedId, removeElement, duplicateElement } = useDoc.getState()
      if (!selectedId) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        removeElement(selectedId)
      } else if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault() // browser's add-bookmark
        duplicateElement(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
