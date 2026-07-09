// CodeMirror language support for Logo. A StreamLanguage (purely lexical) is the right tool here:
// Logo's *syntax* is arity-directed — `fd 10 rt 90` parses by knowing fd takes one input — which no
// grammar can express, and the real syntax intelligence (diagnostics, symbols, params) comes from
// the Rust analyzer anyway (see analysis.ts). Highlighting only needs the lexical layer, which
// mirrors crate/src/logo/lex.rs: comments, "words, :vars, numbers, operators, brackets, and names
// classified against the builtin table.
import { StreamLanguage } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { logoBuiltins } from './analysis'

/** Control/definition words get the strong keyword colour; other builtins a softer one. */
const KEYWORDS = new Set([
  'to', 'end', 'output', 'op', 'stop', 'make', 'local', 'localmake', 'param',
  'repeat', 'if', 'ifelse', 'for', 'while', 'foreach', 'map', 'filter', 'run',
])

let builtinNames: Set<string> | null = null
function isBuiltin(name: string): boolean {
  if (!builtinNames) {
    builtinNames = new Set()
    for (const b of logoBuiltins()) {
      builtinNames.add(b.name)
      for (const a of b.aliases) builtinNames.add(a)
    }
  }
  return builtinNames.has(name)
}

// Word characters mirror the Rust lexer's `is_word_char`.
const WORD = /[^\s()[\]+\-*/=<>;":]/

export const logoLanguage = StreamLanguage.define<Record<string, never>>({
  name: 'logo',
  token(stream) {
    if (stream.eatSpace()) return null
    if (stream.eat(';')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.eat('"')) {
      while (!stream.eol() && WORD.test(stream.peek()!)) stream.next()
      return 'string'
    }
    if (stream.eat(':')) {
      while (!stream.eol() && WORD.test(stream.peek()!)) stream.next()
      return 'variableName'
    }
    if (stream.match(/^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^(<=|>=|<>|[+\-*/=<>])/)) return 'operator'
    if (stream.eat(/[[\]()]/)) return 'bracket'
    let w = ''
    while (!stream.eol() && WORD.test(stream.peek()!)) w += stream.next()
    if (!w) {
      stream.next() // unknown char — consume so the tokenizer always advances
      return null
    }
    const lw = w.toLowerCase()
    if (KEYWORDS.has(lw)) return 'keyword'
    if (lw === 'true' || lw === 'false') return 'atom'
    if (isBuiltin(lw)) return 'builtin'
    return null // user procedure / unknown — plain text; the linter marks real unknowns
  },
  languageData: {
    commentTokens: { line: ';' },
  },
  tokenTable: {
    builtin: t.standard(t.variableName),
  },
})
