// Autocomplete for the Logo editor: builtins (with signature + doc) from the Rust vocabulary
// table, plus the current program's procedures and variables from the analyzer. Context-aware:
// after `:` (a variable reference) or `"` (a variable *name*, e.g. for make) only names complete.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { analyzeLogo, logoBuiltins } from './analysis'

const NAME = /[^\s()[\]+\-*/=<>;":]*/

/** All variable-ish names in scope: params/globals + every procedure's formal args. */
function variableNames(src: string): string[] {
  const a = analyzeLogo(src)
  const names = new Set<string>(a.globals)
  for (const p of a.procs) for (const n of p.argNames) names.add(n)
  return [...names]
}

export function logoCompletions(context: CompletionContext): CompletionResult | null {
  const src = context.state.doc.toString()

  const varRef = context.matchBefore(new RegExp(':' + NAME.source + '$'))
  if (varRef) {
    return {
      from: varRef.from,
      options: variableNames(src).map((n) => ({ label: ':' + n, type: 'variable' })),
      validFor: new RegExp('^:' + NAME.source + '$'),
    }
  }

  const nameRef = context.matchBefore(new RegExp('"' + NAME.source + '$'))
  if (nameRef) {
    return {
      from: nameRef.from,
      options: variableNames(src).map((n) => ({ label: '"' + n, type: 'variable' })),
      validFor: new RegExp('^"' + NAME.source + '$'),
    }
  }

  const word = context.matchBefore(new RegExp(NAME.source + '$'))
  if ((!word || word.from === word.to) && !context.explicit) return null

  const options: Completion[] = []
  for (const b of logoBuiltins()) {
    const detail = b.args.length ? b.args.join(' ') : undefined
    options.push({ label: b.name, type: 'function', detail, info: b.doc })
    for (const a of b.aliases) {
      options.push({ label: a, type: 'function', detail, info: `${b.doc} (alias of ${b.name})` })
    }
  }
  const a = analyzeLogo(src)
  for (const p of a.procs) {
    options.push({
      label: p.name,
      type: 'function',
      detail: p.argNames.map((n) => ':' + n).join(' ') || undefined,
      info: 'Defined in this program.',
      boost: 1, // the user's own procedures over same-prefix builtins
    })
  }
  return {
    from: word ? word.from : context.pos,
    options,
    validFor: new RegExp('^' + NAME.source + '$'),
  }
}
