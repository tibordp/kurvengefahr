// Typed, memoized access to the Rust Logo analyzer (parse-only, synchronous main-thread WASM).
// One `logo_analyze` call serves all three consumers — inspector param knobs, editor diagnostics,
// and autocomplete symbols — so the memo is a single entry keyed by the exact source string (the
// common case is many readers of the same element's current source per render).
//
// All offsets are UTF-16 code units (CodeMirror's position space).
import { logo_analyze, logo_builtins } from '../../core/wasm'

export interface LogoDiagnostic {
  from: number
  to: number
  severity: 'error' | 'warning'
  message: string
}

export interface LogoParamDecl {
  name: string
  /** Only 'number' today; the shape leaves room for select/checkbox params later. */
  kind: 'number'
  default: number
  min?: number
  max?: number
  /** Optional knob step from `param "n 4 [0 10 2]` — the runtime snaps overrides to this grid. */
  step?: number
}

export interface LogoProcInfo {
  name: string
  argNames: string[]
  from: number
}

export interface LogoAnalysis {
  diagnostics: LogoDiagnostic[]
  params: LogoParamDecl[]
  procs: LogoProcInfo[]
  globals: string[]
  usesRandom: boolean
}

let memo: { source: string; analysis: LogoAnalysis } | null = null

export function analyzeLogo(source: string): LogoAnalysis {
  if (memo?.source === source) return memo.analysis
  const analysis = JSON.parse(logo_analyze(source)) as LogoAnalysis
  memo = { source, analysis }
  return analysis
}

export interface LogoBuiltin {
  name: string
  aliases: string[]
  args: string[]
  doc: string
  category: string
}

let builtinsCache: LogoBuiltin[] | null = null

/** The builtin vocabulary (static — fetched from Rust once and cached). */
export function logoBuiltins(): LogoBuiltin[] {
  if (!builtinsCache) builtinsCache = JSON.parse(logo_builtins()) as LogoBuiltin[]
  return builtinsCache
}
