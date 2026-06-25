// Undo / redo for the working document (elements + machine profile + fiducial). Selection is
// captured and restored for context, but a selection-only change is never its own undo step.
//
// It's a snapshot history over the `useDoc` store. Because every store edit spreads new objects
// (strict immutability), a snapshot is just the four current references — cheap, no deep clone.
// Continuous gestures (canvas drags, inspector field/slider sessions) are coalesced into one step
// via begin/end transactions; every other mutation is one step each. Worker geometry never mutates
// undoable state (it writes a separate cache + a `notifyGeometry()` ref-bump), so the content
// fingerprint ignores it for free.
import { create } from 'zustand'
import { useDoc } from './document'
import type { DocSnapshot } from './persistence/schema'

type Snapshot = DocSnapshot
const MAX_DEPTH = 100

// Best-effort per-tab persistence: the undo stack survives refresh / navigation-away / switching to
// another doc and back, but NEVER outlives the tab (sessionStorage, never localStorage). Keyed by
// document id + a fingerprint of the document it was built on, so a doc changed underneath us (e.g.
// a cross-tab edit) is detected and the stale stack is dropped, never applied. Disposable: on any
// write failure we nuke the whole key and carry on with in-memory history.
const UNDO_KEY = 'kg-undo'
type StoredEntry = { fp: string; past: Snapshot[]; future: Snapshot[] }

function readMap(): Record<string, StoredEntry> {
  try {
    const raw = sessionStorage.getItem(UNDO_KEY)
    return raw ? (JSON.parse(raw) as Record<string, StoredEntry>) : {}
  } catch {
    return {}
  }
}

/** Reactive stacks — only used to drive the toolbar buttons' enabled state. All the logic lives in
 *  the functions below; the store itself just holds the two stacks. */
export const useHistory = create<{ past: Snapshot[]; future: Snapshot[] }>(() => ({
  past: [],
  future: [],
}))

const snap = (): Snapshot => {
  const { elements, profile, selectedIds, fiducial } = useDoc.getState()
  return { elements, profile, selectedIds, fiducial }
}
// Fingerprint of undoable CONTENT only — excludes `selectedIds`, so selecting is not an undo step.
// A `notifyGeometry()` ref-bump keeps the same element objects, so it serializes identically.
const fp = (s: Snapshot): string => JSON.stringify([s.elements, s.profile, s.fiducial])

let present: Snapshot | null = null
let presentFp = ''
let depth = 0
let txnStart: Snapshot | null = null
let txnStartFp = ''
let restoring = false

// Canvas gestures fire dragend/transformend once PER selected node; beginGesture/endGesture collapse
// that synchronous burst into a single transaction (begin once, end once on a microtask).
let burstActive = false
let endQueued = false

function begin(): void {
  if (depth++ === 0) {
    txnStart = present
    txnStartFp = presentFp
  }
}

function commitTxn(): void {
  if (present && txnStart && fp(present) !== txnStartFp) {
    const start = txnStart
    useHistory.setState((s) => ({ past: [...s.past, start].slice(-MAX_DEPTH), future: [] }))
    presentFp = fp(present)
  }
}

function end(): void {
  if (depth === 0) return
  if (--depth === 0) commitTxn()
}

function flush(): void {
  if (depth === 0) return
  depth = 0
  burstActive = false
  commitTxn()
}

/** Begin a canvas gesture — idempotent across a multi-node start burst. */
export function beginGesture(): void {
  if (burstActive) return
  burstActive = true
  begin()
}

/** End a canvas gesture once the synchronous per-node end burst has settled. */
export function endGesture(): void {
  if (endQueued) return
  endQueued = true
  queueMicrotask(() => {
    endQueued = false
    if (burstActive) {
      burstActive = false
      end()
    }
  })
}

function apply(s: Snapshot): void {
  restoring = true
  useDoc.getState().loadDocument(s)
  restoring = false
  present = s
  presentFp = fp(s)
}

export function undo(): void {
  flush()
  const { past, future } = useHistory.getState()
  if (!past.length) return
  const leaving = present
  apply(past[past.length - 1])
  useHistory.setState({ past: past.slice(0, -1), future: leaving ? [...future, leaving] : future })
}

export function redo(): void {
  flush()
  const { past, future } = useHistory.getState()
  if (!future.length) return
  const leaving = present
  apply(future[future.length - 1])
  useHistory.setState({
    future: future.slice(0, -1),
    past: leaving ? [...past, leaving].slice(-MAX_DEPTH) : past,
  })
}

/** Re-seed the in-memory baseline from the current document and drop any open transaction. */
function seed(): void {
  present = snap()
  presentFp = fp(present)
  depth = 0
  burstActive = false
  endQueued = false
  txnStart = null
}

/** Re-seed the baseline from the current document and clear the stacks (no persistence). Used for a
 *  cross-tab remote replacement: the remote state is the new baseline, not an undoable local step. */
export function reset(): void {
  seed()
  useHistory.setState({ past: [], future: [] })
}

/** Persist the current doc's stack to sessionStorage (best-effort), stamped with `presentFp`. Called
 *  when leaving a document state — a switch away, or tab hide/close — paired with a doc autosave
 *  flush so the stamped fingerprint matches what re-entry will load. */
export function leave(docId: string): void {
  if (present === null || !docId) return
  const { past, future } = useHistory.getState()
  const map = readMap()
  map[docId] = { fp: presentFp, past, future }
  try {
    sessionStorage.setItem(UNDO_KEY, JSON.stringify(map))
  } catch {
    try {
      sessionStorage.removeItem(UNDO_KEY) // give up on persistence; in-memory history continues
    } catch {
      /* ignore */
    }
  }
}

/** Enter a document: seed the baseline from the just-loaded doc, and restore its persisted stack
 *  only if the saved fingerprint still matches the loaded content (else start fresh). */
export function enter(docId: string): void {
  seed()
  const entry = readMap()[docId]
  if (entry && entry.fp === presentFp && Array.isArray(entry.past) && Array.isArray(entry.future)) {
    useHistory.setState({ past: entry.past, future: entry.future })
  } else {
    useHistory.setState({ past: [], future: [] })
  }
}

/** Attach the capture subscription + the global field-edit focus bracket. Call once at boot. */
export function wireHistory(): void {
  useDoc.subscribe(() => {
    const cur = snap()
    if (restoring || present === null) {
      present = cur
      presentFp = fp(cur)
      return
    }
    if (depth > 0) {
      present = cur // inside a gesture / field session → coalesce; fp is checked at end()
      return
    }
    const f = fp(cur)
    if (f === presentFp) {
      present = cur // selection-only change, or a geometry-only re-render
      return
    }
    const prev = present
    useHistory.setState((s) => ({ past: [...s.past, prev].slice(-MAX_DEPTH), future: [] }))
    present = cur
    presentFp = f
  })

  // A whole text/number/slider edit session (focusin → focusout) collapses to one step. Only
  // CONTINUOUS-edit controls are bracketed — a button/select/checkbox that mutates and keeps focus
  // must commit its step immediately (those go through the subscribe at depth 0), or the Undo
  // button would look disabled until the control blurs. The Konva canvas isn't focusable, so canvas
  // gestures never trip this (they use beginGesture/endGesture). Non-document fields (snap size, doc
  // name) bracket too but change no content → no entry.
  window.addEventListener('focusin', (e) => {
    if (coalescesEdits(e.target)) begin()
  })
  window.addEventListener('focusout', (e) => {
    if (coalescesEdits(e.target)) end()
  })
}

/** A control whose edits stream and should coalesce into one undo step over a focus session. */
function coalescesEdits(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  if (el.tagName !== 'INPUT') return false
  // `Num` fields are type="text" (see CLAUDE.md); sliders are type="range". Discrete inputs
  // (checkbox/radio/color/button) commit per change instead.
  const t = (el as HTMLInputElement).type
  return t === 'text' || t === 'number' || t === 'range' || t === 'search'
}
