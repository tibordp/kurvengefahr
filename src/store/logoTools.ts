// Global library of user-saved Logo tools: a named source snapshot that appears as a stamp-button
// in the tool sidebar for every document. Modeled on store/library.ts (machine profiles): one
// persisted localStorage list, last-write-wins cross-tab sync, import merges with fresh ids.
// Stamped elements copy the source and are self-contained — editing an element never touches the
// tool; "Update" on a tool never touches placed elements.
import { create } from 'zustand'
import { CURRENT_TOOLS_SCHEMA, loadStoredTools, type LogoTool } from './persistence/schema'

export type { LogoTool }

const KEY = 'kg-tools'

function read(): LogoTool[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const res = loadStoredTools(JSON.parse(raw))
    if (res.status === 'ok') return res.value
    if (res.status === 'unsupported') console.warn(`[kg] tool library: ${res.message}; ignoring`)
    return []
  } catch {
    return []
  }
}

function write(tools: LogoTool[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ schemaVersion: CURRENT_TOOLS_SCHEMA, tools }))
  } catch (e) {
    console.warn('[kg] failed to persist tool library', e)
  }
}

interface LogoToolsStore {
  tools: LogoTool[]
  /** Save a source under a new tool; returns the created tool (with its id). */
  addTool: (name: string, source: string) => LogoTool
  /** Overwrite an existing tool's source (matched by id), keeping its name. */
  updateTool: (id: string, source: string) => void
  removeTool: (id: string) => void
  renameTool: (id: string, name: string) => void
  /** Merge imported tools in, assigning fresh ids (never clobber an existing id). */
  importTools: (tools: LogoTool[]) => void
  /** Replace from storage (used by the cross-tab `storage` listener). */
  _hydrate: (tools: LogoTool[]) => void
}

export const useLogoTools = create<LogoToolsStore>((set, get) => {
  const commit = (tools: LogoTool[]) => {
    write(tools)
    set({ tools })
  }
  return {
    tools: read(),

    addTool: (name, source) => {
      const created: LogoTool = { id: crypto.randomUUID(), name, source }
      commit([...get().tools, created])
      return created
    },

    updateTool: (id, source) => commit(get().tools.map((t) => (t.id === id ? { ...t, source } : t))),

    removeTool: (id) => commit(get().tools.filter((t) => t.id !== id)),

    renameTool: (id, name) => commit(get().tools.map((t) => (t.id === id ? { ...t, name } : t))),

    importTools: (tools) =>
      commit([...get().tools, ...tools.map((t) => ({ ...t, id: crypto.randomUUID() }))]),

    _hydrate: (tools) => set({ tools }),
  }
})

/** Keep tabs in sync: another tab editing the tool library updates ours (last-write-wins). */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    useLogoTools.getState()._hydrate(read())
  })
}
