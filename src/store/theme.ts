// App-wide appearance preference: light / dark / system. Persisted to localStorage (app-wide, like
// the profile library — not per-document, not per-tab), applied by toggling the `.dark` class on
// <html> so every token-driven utility tracks it (see index.css). The no-flash boot script in
// index.html applies the same resolution before first paint; this store is the runtime source of
// truth and keeps DOM + localStorage + other tabs in sync.
import { create } from 'zustand'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'kg-theme'

const read = (): Theme => {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // ignore (private mode / disabled storage) — fall back to following the OS
  }
  return 'system'
}

const prefersDark = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches

/** Resolve a choice to effective light/dark and apply it to <html>. */
const apply = (theme: Theme) => {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark())
  const el = document.documentElement
  el.classList.toggle('dark', dark)
  el.style.colorScheme = dark ? 'dark' : 'light'
}

interface ThemeStore {
  theme: Theme
  setTheme: (theme: Theme) => void
}

export const useTheme = create<ThemeStore>((set) => ({
  theme: read(),
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      // ignore — still apply for this session
    }
    apply(theme)
    set({ theme })
  },
}))

// Keep `system` live: react to OS scheme flips while the user is on `system`.
if (typeof matchMedia !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useTheme.getState().theme === 'system') apply('system')
  })
}

// Cross-tab sync: another tab changed the preference (storage fires in *other* tabs only).
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return
  const next = (e.newValue ?? 'system') as Theme
  if (next === 'light' || next === 'dark' || next === 'system') {
    apply(next)
    useTheme.setState({ theme: next })
  }
})
