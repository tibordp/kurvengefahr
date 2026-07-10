// Drift guard for the shortcut source of truth: a new tool or binding must not shadow an
// existing key, and the Help dialog must keep listing every tool.
import { describe, expect, it } from 'vitest'
import { SHORTCUT_GROUPS, TOOLS, TOOL_KEYS } from './shortcuts'

describe('shortcut registry consistency', () => {
  it('assigns every tool a unique single key and a unique tool id', () => {
    const keys = TOOLS.map((t) => t.key.toLowerCase())
    expect(new Set(keys).size).toBe(TOOLS.length)
    const ids = TOOLS.map((t) => t.tool)
    expect(new Set(ids).size).toBe(TOOLS.length)
    // The derived key → tool map covers the whole palette (a duplicate key would shadow a tool).
    expect(Object.keys(TOOL_KEYS)).toHaveLength(TOOLS.length)
  })

  it('lists every tool in the Help dialog', () => {
    const tools = SHORTCUT_GROUPS.find((g) => g.title === 'Tools')
    expect(tools).toBeDefined()
    for (const t of TOOLS) {
      expect(tools!.items.some((i) => i.keys.includes(t.key) && i.label === t.label)).toBe(true)
    }
  })

  it('never repeats a key combination within a group', () => {
    for (const group of SHORTCUT_GROUPS) {
      const combos = group.items.map((i) => i.keys.join('+').toLowerCase())
      expect(new Set(combos).size).toBe(combos.length)
    }
  })
})
