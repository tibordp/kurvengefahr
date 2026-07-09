// The CodeMirror 6 editor inside the Logo dock. Lazy-loaded (see LogoDock) so CM never ships to
// users who don't touch Logo. One instance per element (the dock keys on element id).
//
// Data flow, both directions guarded:
//   - user typing → updateListener → setParams(source) → the generation controller's debounce
//     re-runs the program (the store write per keystroke is cheap; geometry work is debounced).
//   - external source changes (undo/redo, cross-tab sync, the dock's example insert) → store
//     subscription → replace the CM doc, tagged External so the update listener doesn't echo it
//     back. Because every keystroke writes through, buffer and store only ever differ when the
//     change really was external — so a plain content-equality check is the whole guard (no
//     focus test: a mid-typing cross-tab conflict resolves last-write-wins, like the rest of the
//     app).
//
// Diagnostics: the linter maps the Rust analyzer's parse-time diagnostics plus the *runtime* error
// of the last failed run (from useGeneration status detail) into squiggles; runtime spans are
// clamped to the current doc (the user keeps typing after a failed run) and deduped against parse
// diagnostics. Undo granularity: the app's global focusin/focusout history bracket makes one focus
// session one app-level undo step — same as the inspector textareas; CM's own history handles
// in-editor undo while typing.
import { useEffect, useRef } from 'react'
import { Annotation, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { forceLinting, linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { tags as t } from '@lezer/highlight'
import { useDoc } from '../store/document'
import { useGeneration } from '../core/generation'
import type { LogoParams } from '../elements/logo'
import type { LogoRunError } from '../core/wasm/logoWorker'
import { analyzeLogo } from '../elements/logo/analysis'
import { logoLanguage } from '../elements/logo/language'
import { logoCompletions } from '../elements/logo/completion'

/** Marks transactions that mirror an external store change (undo, cross-tab) into the editor. */
const External = Annotation.define<boolean>()

// Chrome-matching editor theme on the app's Tailwind tokens (single light theme, like the app).
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '12px',
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
  },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-faint)',
    borderRight: '1px solid var(--color-border)',
  },
  '.cm-activeLine': { backgroundColor: 'rgb(0 0 0 / 0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgb(0 0 0 / 0.03)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgb(229 72 77 / 0.14)', // accent at low alpha
  },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow-panel)',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '11px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-accent-subtle)',
    color: 'var(--color-text)',
  },
  '.cm-completionDetail': { color: 'var(--color-muted)', fontStyle: 'normal' },
})

// A restrained code palette: brand red for control keywords, cool tones for the rest.
const logoHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--color-faint)', fontStyle: 'italic' },
  { tag: t.keyword, color: 'var(--color-accent-text)', fontWeight: '600' },
  { tag: t.standard(t.variableName), color: '#2563eb' }, // builtins
  { tag: t.variableName, color: '#0d9488' }, // :variables
  { tag: t.string, color: '#b45309' }, // "words
  { tag: t.number, color: '#0e7490' },
  { tag: t.atom, color: '#0e7490' },
  { tag: t.operator, color: 'var(--color-muted)' },
  { tag: t.bracket, color: 'var(--color-muted)' },
])

function currentSource(id: string): string {
  const el = useDoc.getState().elements.find((e) => e.id === id)
  return el ? (el.params as LogoParams).source : ''
}

/** Analyzer diagnostics + the last run's runtime error, clamped and deduped. */
function lintSource(id: string) {
  return (view: EditorView): Diagnostic[] => {
    const src = view.state.doc.toString()
    const len = view.state.doc.length
    const clamp = (n: number) => Math.max(0, Math.min(n, len))
    const out: Diagnostic[] = analyzeLogo(src).diagnostics.map((d) => {
      const from = clamp(d.from)
      return { from, to: Math.max(from, clamp(d.to)), severity: d.severity, message: d.message }
    })
    const status = useGeneration.getState().status[id]
    if (status?.phase === 'error' && status.detail) {
      const e = status.detail as LogoRunError
      if (typeof e.from === 'number' && typeof e.to === 'number') {
        const from = clamp(e.from)
        const to = Math.max(from, clamp(e.to))
        if (!out.some((d) => d.from === from && d.message === e.message)) {
          out.push({ from, to, severity: 'error', message: e.message })
        }
      }
    }
    return out
  }
}

export default function LogoEditor({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const view = new EditorView({
      state: EditorState.create({
        doc: currentSource(id),
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ override: [logoCompletions] }),
          linter(lintSource(id), { delay: 300 }),
          lintGutter(),
          logoLanguage,
          syntaxHighlighting(logoHighlight),
          editorTheme,
          EditorView.lineWrapping,
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            if (u.transactions.every((tr) => tr.annotation(External))) return
            const el = useDoc.getState().elements.find((e) => e.id === id)
            if (!el) return
            useDoc.getState().setParams(id, { ...(el.params as LogoParams), source: u.state.doc.toString() })
          }),
        ],
      }),
      parent: host.current!,
    })

    // External source changes (undo/redo, cross-tab, example insert): mirror into the buffer.
    // Content equality filters out the echoes of our own writes (see the header comment).
    const unsubDoc = useDoc.subscribe((s) => {
      const el = s.elements.find((e) => e.id === id)
      if (!el) return
      const src = (el.params as LogoParams).source
      if (src !== view.state.doc.toString()) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: src },
          annotations: External.of(true),
        })
      }
    })
    // A finished/failed run changes the runtime diagnostic — re-lint outside the type-delay.
    const unsubGen = useGeneration.subscribe((s, prev) => {
      if (s.status[id] !== prev.status[id]) forceLinting(view)
    })
    view.focus()
    return () => {
      unsubDoc()
      unsubGen()
      view.destroy()
    }
  }, [id])

  return <div ref={host} className="h-full min-h-0 [&>.cm-editor]:h-full" />
}
