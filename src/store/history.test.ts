// The undo state machine: content fingerprints (selection and geometry ref-bumps are never undo
// steps) and gesture coalescing (a multi-node drag burst = one step). Runs in node with a stubbed
// window/sessionStorage — the only browser surface history touches.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDENTITY_TRANSFORM, type DocElement } from '../core/types'
import { useDoc } from './document'
import { useHistory, beginGesture, endGesture, enter, leave, redo, undo, wireHistory } from './history'

// history touches window/sessionStorage only from wireHistory()/leave()/enter() — never at import
// time — so stubbing here, before the beforeAll that wires it, is early enough.
const sessionStore = new Map<string, string>()
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => sessionStore.get(k) ?? null,
  setItem: (k: string, v: string) => void sessionStore.set(k, v),
  removeItem: (k: string) => void sessionStore.delete(k),
})
vi.stubGlobal('window', { addEventListener: () => {} })

const rect = (id: string, w = 10): DocElement => ({
  id,
  type: 'rect',
  transform: IDENTITY_TRANSFORM,
  params: { width: w, height: 5, hatch: undefined },
  pen: 0,
})

const past = () => useHistory.getState().past
const future = () => useHistory.getState().future
const elementIds = () => useDoc.getState().elements.map((e) => e.id)
const settleGesture = () => new Promise<void>((r) => queueMicrotask(r))

beforeAll(() => wireHistory())
beforeEach(() => {
  useDoc.setState({ elements: [], selectedIds: [], fiducial: null })
  enter('test-doc') // re-seed the baseline and clear the stacks
  sessionStore.clear()
})

describe('undo history', () => {
  it('records one step per content edit at rest', () => {
    useDoc.setState({ elements: [rect('a')] })
    useDoc.setState({ elements: [rect('a'), rect('b')] })
    expect(past()).toHaveLength(2)
  })

  it('never records selection-only changes or identical-content ref bumps', () => {
    useDoc.setState({ elements: [rect('a')] })
    expect(past()).toHaveLength(1)
    useDoc.setState({ selectedIds: ['a'] })
    useDoc.getState().notifyGeometry() // the autosave/undo no-op contract
    useDoc.setState({ elements: [...useDoc.getState().elements] })
    expect(past()).toHaveLength(1)
  })

  it('coalesces a gesture into a single step, tolerating start/end bursts', async () => {
    beginGesture()
    beginGesture() // multi-node drag: one begin per node
    useDoc.setState({ elements: [rect('a', 10)] })
    useDoc.setState({ elements: [rect('a', 12)] })
    useDoc.setState({ elements: [rect('a', 15)] })
    endGesture()
    endGesture()
    await settleGesture()
    expect(past()).toHaveLength(1)
    undo()
    expect(elementIds()).toEqual([])
  })

  it('records nothing for a gesture with no net change', async () => {
    const before = useDoc.getState().elements
    beginGesture()
    useDoc.setState({ elements: [rect('a')] })
    useDoc.setState({ elements: before })
    endGesture()
    await settleGesture()
    expect(past()).toHaveLength(0)
  })

  it('round-trips undo/redo and drops the future on a new edit', () => {
    useDoc.setState({ elements: [rect('a')] })
    useDoc.setState({ elements: [rect('a'), rect('b')] })
    undo()
    expect(elementIds()).toEqual(['a'])
    expect(future()).toHaveLength(1)
    redo()
    expect(elementIds()).toEqual(['a', 'b'])
    undo()
    useDoc.setState({ elements: [rect('a'), rect('c')] }) // divergent edit
    expect(future()).toHaveLength(0)
    expect(elementIds()).toEqual(['a', 'c'])
  })

  it('caps the stack at MAX_DEPTH', () => {
    for (let i = 0; i < 105; i++) useDoc.setState({ elements: [rect('a', i + 1)] })
    expect(past()).toHaveLength(100)
  })

  it('restores a persisted stack on re-entry only while the doc is unchanged', () => {
    useDoc.setState({ elements: [rect('a')] })
    leave('test-doc')
    enter('test-doc')
    expect(past()).toHaveLength(1) // fingerprint matched → stack restored

    useDoc.setState({ elements: [rect('z')] }) // doc changed underneath (e.g. cross-tab edit)
    enter('test-doc')
    expect(past()).toHaveLength(0) // stale stack dropped, never applied
  })
})
