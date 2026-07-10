// The never-throw persistence contract: loaders are total functions returning an Outcome, the
// version gate fences off future schemas, and sanitizers make any object safe. Deliberately does
// NOT pin serialized shapes, defaults, or message copy — those change freely with schema bumps.
import { describe, expect, it, vi } from 'vitest'
// Element types register by side effect; the fixtures below use rect/group/clip.
import '../../elements/shapes'
import '../../elements/group'
import '../../elements/clip'
import { validateProfile } from '../../core/profileValidation'
import {
  CURRENT_DOC_SCHEMA,
  CURRENT_LIBRARY_SCHEMA,
  CURRENT_TOOLS_SCHEMA,
  DOC_FILE_KIND,
  PROFILES_FILE_KIND,
  TOOLS_FILE_KIND,
  documentFile,
  loadStoredDoc,
  loadStoredLibrary,
  loadStoredTools,
  parseDocumentFile,
  parseProfilesFile,
  parseToolsFile,
  profilesFile,
  sanitizeElements,
  sanitizeProfile,
  sanitizeSnapshot,
  serializeDoc,
  toolsFile,
  type Outcome,
} from './schema'
import { PROFILE_PRESETS } from '../profiles'

const GARBAGE: unknown[] = [
  null,
  undefined,
  42,
  'text',
  '',
  [],
  {},
  { schemaVersion: 'x' },
  { elements: 7, profile: 'nope', selectedIds: { a: 1 } },
  { elements: [{ type: 9 }, null, 'x'], profile: { kind: [] }, fiducial: { x: 'a' } },
  { kind: 12, document: 3, profiles: 'zzz', tools: -1 },
]

const wellFormed = (o: Outcome<unknown>) =>
  o.status === 'ok' || ((o.status === 'unsupported' || o.status === 'invalid') && typeof o.message === 'string')

describe('loader totality', () => {
  const loaders: [string, (raw: unknown) => Outcome<unknown>][] = [
    ['loadStoredDoc', loadStoredDoc],
    ['loadStoredLibrary', loadStoredLibrary],
    ['loadStoredTools', loadStoredTools],
    ['parseDocumentFile', parseDocumentFile],
    ['parseProfilesFile', parseProfilesFile],
    ['parseToolsFile', parseToolsFile],
  ]
  it.each(loaders)('%s never throws and always returns a well-formed Outcome', (_name, load) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const raw of GARBAGE) {
      const out = load(raw)
      expect(wellFormed(out)).toBe(true)
    }
    vi.restoreAllMocks()
  })

  it('a garbage object still loads as a valid document (sanitizers backfill everything)', () => {
    const out = loadStoredDoc({ elements: 'not-an-array', profile: 42 })
    expect(out.status).toBe('ok')
    if (out.status === 'ok') {
      expect(Array.isArray(out.value.elements)).toBe(true)
      expect(validateProfile(out.value.profile)).toEqual([])
    }
  })
})

describe('version gate', () => {
  it('reports a future schema as unsupported instead of mangling it', () => {
    expect(loadStoredDoc({ schemaVersion: CURRENT_DOC_SCHEMA + 1 }).status).toBe('unsupported')
    expect(loadStoredLibrary({ schemaVersion: CURRENT_LIBRARY_SCHEMA + 1 }).status).toBe('unsupported')
    expect(loadStoredTools({ schemaVersion: CURRENT_TOOLS_SCHEMA + 1 }).status).toBe('unsupported')
    expect(parseDocumentFile({ kind: DOC_FILE_KIND, schemaVersion: CURRENT_DOC_SCHEMA + 1 }).status).toBe(
      'unsupported',
    )
    expect(parseProfilesFile({ kind: PROFILES_FILE_KIND, schemaVersion: CURRENT_LIBRARY_SCHEMA + 1 }).status).toBe(
      'unsupported',
    )
    expect(parseToolsFile({ kind: TOOLS_FILE_KIND, schemaVersion: CURRENT_TOOLS_SCHEMA + 1 }).status).toBe(
      'unsupported',
    )
  })

  it('rejects a file envelope with the wrong kind', () => {
    expect(parseDocumentFile({ kind: PROFILES_FILE_KIND, schemaVersion: 1 }).status).toBe('invalid')
    expect(parseProfilesFile({ kind: DOC_FILE_KIND, schemaVersion: 1 }).status).toBe('invalid')
    expect(parseToolsFile({ kind: DOC_FILE_KIND, schemaVersion: 1 }).status).toBe('invalid')
  })
})

describe('serialize ↔ parse round-trips', () => {
  it('a document survives documentFile(serializeDoc(…)) → parseDocumentFile', () => {
    const loaded = loadStoredDoc({
      id: 'doc-1',
      name: 'Test doc',
      elements: [
        { id: 'r1', type: 'rect', params: { width: 30, height: 20 } },
        { id: 'g1', type: 'group' },
        { id: 'r2', type: 'rect', params: {}, parent: 'g1' },
      ],
      selectedIds: ['r1'],
      fiducial: { x: 5, y: 6 },
    })
    expect(loaded.status).toBe('ok')
    if (loaded.status !== 'ok') return
    const parsed = parseDocumentFile(documentFile(serializeDoc(loaded.value)))
    expect(parsed.status).toBe('ok')
    if (parsed.status !== 'ok') return
    expect(parsed.value.name).toBe('Test doc')
    expect(parsed.value.snapshot).toEqual({
      elements: loaded.value.elements,
      profile: loaded.value.profile,
      selectedIds: loaded.value.selectedIds,
      fiducial: loaded.value.fiducial,
    })
  })

  it('the profile library survives profilesFile → parseProfilesFile', () => {
    const parsed = parseProfilesFile(profilesFile(structuredClone(PROFILE_PRESETS)))
    expect(parsed.status).toBe('ok')
    if (parsed.status === 'ok') expect(parsed.value).toEqual(PROFILE_PRESETS)
  })

  it('logo tools survive toolsFile → parseToolsFile', () => {
    const tools = [{ id: 't1', name: 'Spiral', source: 'repeat 10 [fd 5 rt 36]' }]
    const parsed = parseToolsFile(toolsFile(tools))
    expect(parsed).toEqual({ status: 'ok', value: tools })
  })
})

describe('sanitizeSnapshot container reconciliation', () => {
  it('drops a parent/clipRole whose container is gone', () => {
    const snap = sanitizeSnapshot({
      elements: [{ id: 'r1', type: 'rect', params: {}, parent: 'gone', clipRole: 'mask' }],
    })
    expect(snap.elements).toHaveLength(1)
    expect(snap.elements[0].parent).toBeUndefined()
    expect(snap.elements[0].clipRole).toBeUndefined()
  })

  it('prunes containers left without members, keeps populated ones', () => {
    const snap = sanitizeSnapshot({
      elements: [
        { id: 'empty', type: 'group' },
        { id: 'full', type: 'clip' },
        { id: 'r1', type: 'rect', params: {}, parent: 'full', clipRole: 'mask' },
      ],
    })
    expect(snap.elements.map((e) => e.id)).toEqual(['full', 'r1'])
    expect(snap.elements[1]).toMatchObject({ parent: 'full', clipRole: 'mask' })
  })

  it('filters the selection to surviving ids and accepts the legacy single selectedId', () => {
    const els = [{ id: 'r1', type: 'rect', params: {} }]
    expect(sanitizeSnapshot({ elements: els, selectedIds: ['r1', 'ghost', 42] }).selectedIds).toEqual(['r1'])
    expect(sanitizeSnapshot({ elements: els, selectedId: 'r1' }).selectedIds).toEqual(['r1'])
  })
})

describe('sanitizeElements', () => {
  it('drops unknown element types and lifts the legacy params.pen', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const els = sanitizeElements([
      { id: 'a', type: 'from-the-future', params: {} },
      { id: 'b', type: 'rect', params: { pen: 3 } },
      { id: 'c', type: 'rect', params: {}, pen: 1 },
    ])
    warn.mockRestore()
    expect(els.map((e) => e.id)).toEqual(['b', 'c'])
    expect(els[0].pen).toBe(3) // lifted from legacy params.pen
    expect(els[1].pen).toBe(1) // top-level pen wins
  })
})

describe('sanitizeProfile', () => {
  it('dispatches on kind, coercing unknown kinds to prusa', () => {
    expect(sanitizeProfile({ kind: 'axidraw' }).kind).toBe('axidraw')
    expect(sanitizeProfile({ kind: 'grbl' }).kind).toBe('grbl')
    expect(sanitizeProfile({ kind: 'reprap' }).kind).toBe('prusa')
    expect(sanitizeProfile(null).kind).toBe('prusa')
  })

  it('always produces a profile that passes validateProfile', () => {
    for (const raw of [...GARBAGE, { kind: 'grbl', pen: { mode: 'servo', upS: 'x' } }, { kind: 'axidraw', servo: 7 }])
      expect(validateProfile(sanitizeProfile(raw))).toEqual([])
  })
})
