// Single source of truth for keyboard shortcuts. Shared by three places so they never drift:
//   • `useShortcuts` — the global key handler (TOOL_KEYS, derived below)
//   • `ToolSidebar` — the tool buttons (TOOLS) and their `(key)` tooltips
//   • `HelpDialog` — the discoverable reference table (SHORTCUT_GROUPS)
import {
  MousePointer2,
  Signature,
  Type,
  Minus,
  Square,
  Circle,
  PenTool,
  Pencil,
  Sparkles,
  Crosshair,
  type LucideIcon,
} from 'lucide-react'
import type { Tool } from '../store/tools'

/** The modifier key glyph, platform-aware (⌘ on Apple, Ctrl elsewhere). Display-only. */
const isApple =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
export const MOD_KEY = isApple ? '⌘' : 'Ctrl'

/** The tool palette: icon + label + single-key shortcut. Drives the sidebar and the key handler. */
export const TOOLS: { tool: Tool; icon: LucideIcon; label: string; key: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
  { tool: 'handwriting', icon: Signature, label: 'Handwriting', key: 'T' },
  { tool: 'text', icon: Type, label: 'Text', key: 'Y' },
  { tool: 'line', icon: Minus, label: 'Line', key: 'L' },
  { tool: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
  { tool: 'pen', icon: PenTool, label: 'Pen (Bézier)', key: 'P' },
  { tool: 'freehand', icon: Pencil, label: 'Freehand', key: 'F' },
  { tool: 'generative', icon: Sparkles, label: 'Generative', key: 'G' },
  { tool: 'fiducial', icon: Crosshair, label: 'Fiducial (align point)', key: 'X' },
]

/** Lower-cased single key → tool, derived from TOOLS so the binding can't drift from the label. */
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.key.toLowerCase(), t.tool]),
)

/** Grouped, human-readable reference for the Help dialog. `keys` are display tokens (chips). */
export interface ShortcutItem {
  keys: string[]
  label: string
}
export const SHORTCUT_GROUPS: { title: string; items: ShortcutItem[] }[] = [
  {
    title: 'Tools',
    items: TOOLS.map((t) => ({ keys: [t.key], label: t.label })),
  },
  {
    title: 'Edit',
    items: [
      { keys: [MOD_KEY, 'Z'], label: 'Undo' },
      { keys: [MOD_KEY, 'Shift', 'Z'], label: 'Redo' },
      { keys: [MOD_KEY, 'A'], label: 'Select all' },
      { keys: [MOD_KEY, 'C'], label: 'Copy' },
      { keys: [MOD_KEY, 'X'], label: 'Cut' },
      { keys: [MOD_KEY, 'V'], label: 'Paste (across documents)' },
      { keys: [MOD_KEY, 'D'], label: 'Duplicate selection' },
      { keys: ['Del'], label: 'Delete selection' },
      { keys: ['↑ ↓ ← →'], label: 'Nudge 1 mm' },
      { keys: ['Shift', '↑ ↓ ← →'], label: 'Nudge 10 mm' },
      { keys: ['Esc'], label: 'Deselect' },
    ],
  },
  {
    title: 'Pen tool',
    items: [
      { keys: ['Click'], label: 'Add a corner node' },
      { keys: ['Click', 'drag'], label: 'Add a node with a curve handle' },
      { keys: ['Right-click'], label: 'Finish path (no extra node)' },
      { keys: ['Double-click'], label: 'Finish path' },
      { keys: ['Click', 'first node'], label: 'Close path' },
      { keys: ['Esc'], label: 'Cancel path' },
    ],
  },
  {
    title: 'Node editing (selected path)',
    items: [
      { keys: ['Click', 'node'], label: 'Select a node' },
      { keys: ['Shift', 'Click'], label: 'Add / remove a node from the selection' },
      { keys: ['Drag', 'empty'], label: 'Rubber-band select nodes (Shift adds)' },
      { keys: ['Drag', 'node'], label: 'Move the selected node(s)' },
      { keys: ['Click', 'midpoint'], label: 'Insert a node on a segment' },
      { keys: ['Del'], label: 'Delete the selected node(s)' },
      { keys: ['Double-click', 'node'], label: 'Toggle corner / smooth' },
      { keys: ['Alt', 'drag handle'], label: 'Break handle symmetry (cusp)' },
    ],
  },
  {
    title: 'View',
    items: [
      { keys: [MOD_KEY, 'K'], label: 'Command palette' },
      { keys: ['Shift', '1'], label: 'Fit everything in view' },
      { keys: ['Shift', '2'], label: 'Fit selection in view' },
    ],
  },
  {
    title: 'Output',
    items: [
      { keys: [MOD_KEY, 'S'], label: 'Generate & download G-code' },
      { keys: ['Space'], label: 'Play / pause preview' },
    ],
  },
  {
    title: 'Help',
    items: [{ keys: ['?'], label: 'Shortcuts & about' }],
  },
]
