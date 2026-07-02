// Inspector: edits the selected element's `params` (→ re-generate) and `transform` (→ re-place),
// plus the document machine profile (→ re-emit). Pure view over the store. On narrow viewports it
// renders as a slide-over drawer (see `useUI`); on desktop it's docked in the layout grid.
import { useEffect, useState } from 'react'
import {
  X,
  Trash2,
  Eye,
  Upload,
  Download,
  Plus,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  Sun,
  Moon,
  Monitor,
  Dices,
  Spline,
  Link2,
  Ungroup,
  Printer,
  ArrowUp,
  ArrowDown,
  FlipHorizontal,
  FlipVertical,
} from 'lucide-react'
import { useDoc, type AlignEdge } from '../store/document'
import { useUI } from '../store/ui'
import { useTheme, type Theme } from '../store/theme'
import { useLibrary } from '../store/library'
import { useGeneration, regenerate, needsManualRegen } from '../core/generation'
import { PROFILE_PRESETS, findBuiltinProfile } from '../store/profiles'
import { hashParams, isMultiPen } from '../elements/registry'
import { profilesFile, parseProfilesFile } from '../store/persistence/schema'
import { drawableRegion } from '../core/pipeline/clip'
import {
  bridgeAvailable,
  grantedPrinters,
  requestPrinters,
  printerStatus,
  type PrinterInfo,
  type PrinterStatus,
} from '../output/plot'
import { downloadJson, pickJsonFile } from '../output/download'
import { substitution_note } from '../core/wasm'
import type { Pen, EffectSpec, EffectType } from '../core/types'
import { pressureEnabled } from '../core/types'
import { EFFECT_DEFS, effectDef, defaultEffect } from '../effects/registry'
import { validateProfile } from '../core/profileValidation'
import type { HandwritingParams } from '../elements/handwriting'
import { SEEDED_METHODS, type RasterParams, type RasterMethod } from '../elements/raster'
import type { RectParams, EllipseParams, PathParams, Hatch, HatchPattern } from '../elements/shapes'
import {
  HERSHEY_FONTS,
  OUTLINE_FONTS,
  type TextParams,
  type TextMode,
  type TextAlign,
} from '../elements/text'
import {
  GEN_KINDS,
  LSYSTEM_PRESETS,
  SEEDED_KINDS,
  type GenerativeParams,
  type GenKind,
} from '../elements/generative'
import { Button, IconButton, Field, SectionTitle, Banner, controlClass, textareaClass, cx } from './primitives'
import { MOD_KEY } from './shortcuts'
import { ElementsTree } from './ElementsTree'



// Display value rounded to a sensible number of decimals (full precision is still stored and
// editable — this only affects what's shown when not actively typing). mm/degrees/scale read fine at
// 2 places; a finer-stepped field (e.g. 0.005) shows enough to resolve its step. Trailing zeros are
// trimmed (140, not 140.00).
const display = (v: number, decimals = 2) =>
  Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : '0'

const decimalsOf = (step: number) => {
  const i = String(step).indexOf('.')
  return i < 0 ? 0 : String(step).length - i - 1
}
/** Decimals to display for a field: 2 by default, more only if the step is finer. */
const displayDecimals = (step: number) => Math.max(2, decimalsOf(step))

// A numeric field that uses `type="text"` so intermediate states ("-", "1.", "") survive while
// typing (type="number" reports an empty value mid-typing, which clobbers negatives). It keeps
// a local string while focused and only commits valid numbers; ArrowUp/Down step like a number
// input. On blur it re-syncs to the canonical value.
function Num({
  label,
  value,
  step = 1,
  onChange,
  title,
}: {
  label: string
  value: number
  step?: number
  onChange: (v: number) => void
  title?: string
}) {
  const dec = displayDecimals(step)
  const [text, setText] = useState(() => display(value, dec))
  const [focused, setFocused] = useState(false)

  // Mirror external changes (canvas drag, selection switch) only when not actively editing.
  useEffect(() => {
    if (!focused) setText(display(value, dec))
  }, [value, focused, dec])

  const stepBy = (dir: number) => {
    const base = Number.isFinite(parseFloat(text)) ? parseFloat(text) : value
    const next = Number(((Number.isFinite(base) ? base : 0) + dir * step).toFixed(6))
    setText(String(next))
    onChange(next)
  }

  return (
    <Field label={label} title={title}>
      <input
        type="text"
        inputMode="decimal"
        className={controlClass}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value)
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            stepBy(1)
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            stepBy(-1)
          }
        }}
      />
    </Field>
  )
}

/** Per-element generation feedback: model load on first use, per-line progress, or an error with
 *  retry. Generation runs in a worker; the element keeps showing its previous ink meanwhile. */
function GenerationNote({ id, reserveIdle = true }: { id: string; reserveIdle?: boolean }) {
  const status = useGeneration((s) => s.status[id])
  // A failure is a persistent, actionable state → a normal banner (it doesn't flash in and out).
  if (status?.phase === 'error') {
    return (
      <Banner
        variant="warn"
        action={
          <button
            className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
            onClick={() => regenerate(id)}
          >
            Retry
          </button>
        }
      >
        ⚠ Generation failed{status.message ? `: ${status.message}` : ''}
      </Banner>
    )
  }
  // Loading / generating flash in and out — a live re-trace fires on every edit. Keep this a
  // fixed-height, single-line slot so showing or clearing the label never reflows the inspector.
  // Handwriting streams word by word (show the line count); raster lands in one shot (no count).
  const progress = status?.total && status.total > 1 ? ` ${status.done ?? 0}/${status.total} lines` : ''
  const text =
    status?.phase === 'loading-model'
      ? '⏳ Loading handwriting model… (first use only)'
      : status?.phase === 'generating'
        ? `✎ Generating…${progress}`
        : ''
  // When there's nothing to say, callers that re-trace constantly (raster) reserve the slot to
  // avoid reflow; ones that generate only on a deliberate Regenerate (handwriting) collapse it so
  // there's no dead gap under the header.
  if (!text && !reserveIdle) return null
  return (
    <p className="mb-2 h-4 truncate text-xs text-muted" aria-live="polite">
      {text && <span className="animate-pulse">{text}</span>}
    </p>
  )
}

function HandwritingInspector({ id, params }: { id: string; params: HandwritingParams }) {
  const setParams = useDoc((s) => s.setParams)
  const update = (patch: Partial<HandwritingParams>) => setParams(id, { ...params, ...patch })
  const setLayout = (patch: Partial<HandwritingParams['layout']>) =>
    update({ layout: { ...params.layout, ...patch } })
  const setStyle = (patch: Partial<HandwritingParams['style']>) =>
    update({ style: { ...params.style, ...patch } })

  // Stateless, model-independent: warn about characters the model can't draw.
  const subs = substitution_note(params.text)
  // Dirty = params edited since the last generation (and nothing currently running).
  const busy = useGeneration((s) => !!s.status[id])
  const dirty = !busy && needsManualRegen(id, 'handwriting', params)

  return (
    <>
      <SectionTitle>Handwriting</SectionTitle>
      <GenerationNote id={id} reserveIdle={false} />
      {dirty && (
        <Banner
          action={
            <Button variant="primary" className="h-7 px-2.5 text-xs" onClick={() => regenerate(id)}>
              Regenerate
            </Button>
          }
        >
          ● Edited — preview is out of date
        </Banner>
      )}
      <Field full>
        <textarea
          className={textareaClass}
          rows={3}
          value={params.text}
          onChange={(e) => update({ text: e.target.value })}
        />
      </Field>
      {subs && (
        <Banner variant="warn">
          <span title="The model's alphabet is limited; these were remapped.">
            ⚠ Substituted: {subs}
          </span>
        </Banner>
      )}
      <Num label="Font (mm)" value={params.layout.fontSizeMm} step={0.5}
        onChange={(v) => setLayout({ fontSizeMm: v })} />
      <Num label="Line height" value={params.layout.lineHeightEm} step={0.1}
        onChange={(v) => setLayout({ lineHeightEm: v })} />
      <Num label="Wrap (mm)" value={params.layout.maxWidthMm} step={5}
        onChange={(v) => setLayout({ maxWidthMm: v })} />
      <Num label="Slant (°)" value={params.layout.slantDeg} step={1}
        onChange={(v) => setLayout({ slantDeg: v })} />
      <Field label="Align">
        <select
          className={controlClass}
          value={params.layout.align}
          onChange={(e) => setLayout({ align: e.target.value as HandwritingParams['layout']['align'] })}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </Field>
      <div className="my-3 flex flex-col gap-2.5">
        <Field
          label="Neatness"
          title="Neatness. Lower = looser/more natural, higher = neater and more legible."
        >
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="min-w-0 flex-1"
              min={0}
              max={2.5}
              step={0.05}
              value={params.style.bias}
              onChange={(e) => setStyle({ bias: parseFloat(e.target.value) })}
            />
            <span className="min-w-[2.6em] text-right text-xs tabular-nums text-muted">
              {params.style.bias.toFixed(2)}
            </span>
          </div>
        </Field>
        <Field
          label="Global optimize"
          title="Off: plot strokes in natural reading order (one locked unit). On: let the optimizer reorder this element's strokes with everything else."
        >
          <input
            type="checkbox"
            className="h-4 w-4 justify-self-start"
            checked={params.globalOptimize}
            onChange={(e) => update({ globalOptimize: e.target.checked })}
          />
        </Field>
      </div>
      <Button
        className="w-full"
        title="Re-roll the letterforms and regenerate"
        onClick={() => {
          setStyle({ seed: Math.floor(Math.random() * 1e9) })
          regenerate(id)
        }}
      >
        <Dices size={15} /> Re-roll
      </Button>
    </>
  )
}

/** The three valid stroke/fill combinations (never both off → no marks). */
type FillStyle = 'stroke' | 'both' | 'fill'
const fillStyle = (h: Hatch): FillStyle =>
  h.pattern === 'none' ? 'stroke' : h.stroke ? 'both' : 'fill'

/** Fill (hatch) controls shared by all closed shapes. Style picks stroke / stroke+fill / fill;
 *  "neither" is unrepresentable. */
function HatchControls({ hatch, onChange }: { hatch: Hatch; onChange: (h: Hatch) => void }) {
  const set = (patch: Partial<Hatch>) => onChange({ ...hatch, ...patch })
  const style = fillStyle(hatch)
  const setStyle = (s: FillStyle) => {
    if (s === 'stroke') return set({ stroke: true, pattern: 'none' })
    // Entering a fill style needs a real pattern; revive 'lines' if there isn't one.
    set({ stroke: s === 'both', pattern: hatch.pattern === 'none' ? 'lines' : hatch.pattern })
  }
  return (
    <>
      <SectionTitle>Fill</SectionTitle>
      <Field label="Style">
        <select className={controlClass} value={style} onChange={(e) => setStyle(e.target.value as FillStyle)}>
          <option value="stroke">Stroke</option>
          <option value="both">Stroke + Fill</option>
          <option value="fill">Fill</option>
        </select>
      </Field>
      {style !== 'stroke' && (
        <>
          <Field label="Pattern">
            <select
              className={controlClass}
              value={hatch.pattern}
              onChange={(e) => set({ pattern: e.target.value as HatchPattern })}
            >
              <option value="lines">Lines</option>
              <option value="cross">Cross-hatch</option>
              <option value="grid">Grid</option>
              <option value="concentric">Concentric</option>
              <option value="hilbert">Hilbert curve</option>
              <option value="gradient">Gradient hatch</option>
              <option value="scribble">Scribble</option>
              <option value="stipple">Stipple (dots)</option>
              <option value="voronoi">Voronoi</option>
              <option value="truchet">Truchet tiles</option>
              <option value="spiral">Spiral</option>
              <option value="maze">Maze</option>
            </select>
          </Field>
          <Num label="Density (mm)" value={hatch.spacing} step={0.5}
            onChange={(v) => set({ spacing: Math.max(0.3, v) })} />
          {(hatch.pattern === 'lines' || hatch.pattern === 'cross') && (
            <Num label="Angle (°)" value={hatch.angle} step={5} onChange={(v) => set({ angle: v })} />
          )}
        </>
      )}
    </>
  )
}

function RectInspector({ id, params }: { id: string; params: RectParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<RectParams>) => setParams(id, { ...params, ...patch })
  return (
    <>
      <SectionTitle>Rectangle</SectionTitle>
      <Num label="Width (mm)" value={params.w} step={1} onChange={(v) => up({ w: Math.max(0, v) })} />
      <Num label="Height (mm)" value={params.h} step={1} onChange={(v) => up({ h: Math.max(0, v) })} />
      <Num label="Corner radius (mm)" value={params.cornerRadius} step={1}
        onChange={(v) => up({ cornerRadius: Math.max(0, v) })} />
      <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
    </>
  )
}

function EllipseInspector({ id, params }: { id: string; params: EllipseParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<EllipseParams>) => setParams(id, { ...params, ...patch })
  return (
    <>
      <SectionTitle>Ellipse</SectionTitle>
      <Num label="Radius X (mm)" value={params.rx} step={1} onChange={(v) => up({ rx: Math.max(0, v) })} />
      <Num label="Radius Y (mm)" value={params.ry} step={1} onChange={(v) => up({ ry: Math.max(0, v) })} />
      <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
    </>
  )
}

function GenerativeInspector({ id, params }: { id: string; params: GenerativeParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<GenerativeParams>) => setParams(id, { ...params, ...patch })
  const k = params.kind
  return (
    <>
      <SectionTitle>Generative</SectionTitle>
      <Field label="Pattern">
        <select className={controlClass} value={k} onChange={(e) => up({ kind: e.target.value as GenKind })}>
          {GEN_KINDS.map((g) => (
            <option key={g.key} value={g.key}>
              {g.name}
            </option>
          ))}
        </select>
      </Field>
      <Num label="Width (mm)" value={params.width} step={5} onChange={(v) => up({ width: Math.max(1, v) })} />
      <Num label="Height (mm)" value={params.height} step={5} onChange={(v) => up({ height: Math.max(1, v) })} />

      {k === 'spirograph' && (
        <>
          <SliderNum label="Outer radius" min={5} max={120} step={1} value={params.outerR} onChange={(v) => up({ outerR: v })} />
          <SliderNum label="Inner radius" min={2} max={120} step={1} value={params.innerR} onChange={(v) => up({ innerR: v })} />
          <SliderNum label="Pen offset" min={0} max={120} step={1} value={params.penOffset} onChange={(v) => up({ penOffset: v })} />
        </>
      )}
      {k === 'lsystem' && (
        <>
          <Field label="Curve">
            <select className={controlClass} value={params.preset} onChange={(e) => up({ preset: e.target.value })}>
              {LSYSTEM_PRESETS.map((pre) => (
                <option key={pre} value={pre}>
                  {pre[0].toUpperCase() + pre.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <SliderNum label="Iterations" min={0} max={8} step={1} value={params.iterations} int onChange={(v) => up({ iterations: v })} />
          <SliderNum label="Angle (°)" min={0} max={180} step={1} value={params.angle} hardMax onChange={(v) => up({ angle: v })} />
        </>
      )}
      {k === 'truchet' && (
        <>
          <SliderNum label="Cell (mm)" min={3} max={40} step={1} value={params.cell} onChange={(v) => up({ cell: v })} />
          <Field label="Tile">
            <select className={controlClass} value={params.style} onChange={(e) => up({ style: e.target.value })}>
              <option value="arcs">Arcs</option>
              <option value="lines">Diagonals</option>
            </select>
          </Field>
        </>
      )}
      {k === 'voronoi' && (
        <SliderNum label="Points" min={3} max={1500} step={1} value={params.points} int onChange={(v) => up({ points: v })} />
      )}
      {k === 'flow' && (
        <>
          <SliderNum label="Spacing (mm)" min={0.5} max={20} step={0.5} value={params.spacing} onChange={(v) => up({ spacing: v })} />
          <SliderNum label="Length (steps)" min={2} max={2000} step={1} value={params.steps} int onChange={(v) => up({ steps: v })} />
          <SliderNum label="Detail" min={0.005} max={0.2} step={0.005} value={params.noiseScale} onChange={(v) => up({ noiseScale: v })} />
        </>
      )}

      {SEEDED_KINDS.has(k) && (
        <Button className="mt-3 w-full" title="Re-roll the random arrangement" onClick={() => up({ seed: Math.floor(Math.random() * 1e9) })}>
          <Dices size={15} /> Re-roll
        </Button>
      )}
    </>
  )
}

function TextInspector({ id, params }: { id: string; params: TextParams }) {
  const setParams = useDoc((s) => s.setParams)
  const up = (patch: Partial<TextParams>) => setParams(id, { ...params, ...patch })
  const fonts = params.mode === 'outline' ? OUTLINE_FONTS : HERSHEY_FONTS
  const setMode = (mode: TextMode) => {
    // Font keys differ per mode; reset to that mode's default if the current one doesn't apply.
    const list = mode === 'outline' ? OUTLINE_FONTS : HERSHEY_FONTS
    const font = list.some((f) => f.key === params.font) ? params.font : list[0].key
    up({ mode, font })
  }
  return (
    <>
      <SectionTitle>Text</SectionTitle>
      <textarea
        className={cx(textareaClass, 'min-h-[3.5rem]')}
        value={params.text}
        placeholder="Type text…"
        onChange={(e) => up({ text: e.target.value })}
      />
      <Field label="Style">
        <select className={controlClass} value={params.mode} onChange={(e) => setMode(e.target.value as TextMode)}>
          <option value="single">Single-line (plotter)</option>
          <option value="outline">Outline</option>
        </select>
      </Field>
      <Field label="Font">
        <select className={controlClass} value={params.font} onChange={(e) => up({ font: e.target.value })}>
          {fonts.map((f) => (
            <option key={f.key} value={f.key}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Num label="Size (mm)" value={params.size} step={1} onChange={(v) => up({ size: Math.max(0.5, v) })} />
      <Num label="Letter spacing (mm)" value={params.letterSpacing} step={0.5}
        onChange={(v) => up({ letterSpacing: v })} />
      <Num label="Line spacing" value={params.lineSpacing} step={0.1}
        onChange={(v) => up({ lineSpacing: Math.max(0.5, v) })} />
      <Field label="Align">
        <select className={controlClass} value={params.align} onChange={(e) => up({ align: e.target.value as TextAlign })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
        </select>
      </Field>
      {params.mode === 'outline' && (
        <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
      )}
    </>
  )
}

function PathInspector({ id, params }: { id: string; params: PathParams }) {
  const setParams = useDoc((s) => s.setParams)
  const simplifySelected = useDoc((s) => s.simplifySelected)
  const weldSelected = useDoc((s) => s.weldSelected)
  const breakApartSelected = useDoc((s) => s.breakApartSelected)
  const [tol, setTol] = useState('0.3')
  const nodeCount = params.contours.reduce((a, c) => a + c.nodes.length, 0)
  const anyClosed = params.contours.some((c) => c.closed)
  const allClosed = params.contours.length > 0 && params.contours.every((c) => c.closed)
  // Weldable only when there are multiple contours and at least one open end to chain.
  const hasOpenContour = params.contours.length > 1 && params.contours.some((c) => !c.closed)
  return (
    <>
      <SectionTitle>Path</SectionTitle>
      <Field label="Closed">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={allClosed}
          onChange={(e) =>
            setParams(id, {
              ...params,
              contours: params.contours.map((c) => ({ ...c, closed: e.target.checked })),
            })
          }
        />
      </Field>
      <p className="note text-xs text-muted">
        {params.contours.length > 1 ? `${params.contours.length} contours · ` : ''}
        {nodeCount} node{nodeCount === 1 ? '' : 's'} · drag points & handles on the canvas to edit.
      </p>
      {/* Path actions in a single 2-col grid so the buttons line up. */}
      <div className="mt-2 grid grid-cols-2 gap-1">
        <div className="flex items-center gap-1.5">
          <input
            className={numFieldClass}
            value={tol}
            inputMode="decimal"
            title="Simplify tolerance in mm — higher removes more nodes"
            onChange={(e) => setTol(e.target.value)}
          />
          <span className="text-xs text-muted">mm</span>
        </div>
        <Button
          title="Reduce node count with Ramer–Douglas–Peucker"
          onClick={() => {
            const t = parseFloat(tol)
            if (Number.isFinite(t) && t > 0) simplifySelected(t)
          }}
        >
          Simplify
        </Button>
        {hasOpenContour && (
          <Button
            title="Weld open contours that share endpoints into single contours (loops close, so they can fill)"
            onClick={() => weldSelected()}
          >
            <Link2 size={15} /> Merge
          </Button>
        )}
        {params.contours.length > 1 && (
          <Button
            className={hasOpenContour ? '' : 'col-span-2'}
            title="Break this compound path into one path per contour"
            onClick={() => breakApartSelected()}
          >
            <Ungroup size={15} /> Break apart
          </Button>
        )}
      </div>
      {anyClosed && (
        <HatchControls
          hatch={params.hatch}
          onChange={(h) => setParams(id, { ...params, hatch: h })}
        />
      )}
    </>
  )
}

/** Compact, right-aligned number input that pairs with a slider (narrow — the inspector column is
 *  tight). Mirrors {@link Num}'s local-edit-then-commit behaviour. */
const numFieldClass =
  'w-[3.6em] shrink-0 rounded-md border border-border bg-surface px-1 h-8 text-sm text-right ' +
  'tabular-nums text-text outline-none transition-colors hover:border-border-strong ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35'

/** A slider with an inline editable number box. The slider's `max` is a *soft* bound — typing a
 *  larger value is allowed (and the thumb just pins at max) unless `hardMax`. `int` rounds. This is
 *  the default raster knob: drag for feel, type for precision, exceed the range when you want to. */
function SliderNum({
  label, title, min, max, step, value, onChange, hardMax = false, int = false, disabled = false,
}: {
  label: string
  title?: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  hardMax?: boolean
  int?: boolean
  disabled?: boolean
}) {
  const dec = int ? 0 : displayDecimals(step)
  const [text, setText] = useState(() => display(value, dec))
  const [focused, setFocused] = useState(false)
  // Mirror external changes (slider drag, regenerate, selection switch) only when not typing.
  useEffect(() => {
    if (!focused) setText(display(value, dec))
  }, [value, focused, dec])

  const clampNum = (n: number) => {
    let v = int ? Math.round(n) : n
    v = Math.max(min, v)
    return hardMax ? Math.min(max, v) : v
  }
  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (Number.isFinite(n)) onChange(clampNum(n))
  }
  const sliderVal = Math.min(max, Math.max(min, value))

  return (
    <Field label={label} title={title}>
      <div className={cx('flex min-w-0 items-center gap-1.5', disabled && 'opacity-40')}>
        <input
          type="range"
          className="min-w-0 flex-1"
          min={min}
          max={max}
          step={step}
          value={sliderVal}
          disabled={disabled}
          onChange={(e) => onChange(clampNum(parseFloat(e.target.value)))}
        />
        <input
          type="text"
          inputMode="decimal"
          className={numFieldClass}
          value={text}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={(e) => {
            setFocused(false)
            commit(e.target.value)
          }}
          onChange={(e) => {
            setText(e.target.value)
            commit(e.target.value)
          }}
        />
      </div>
    </Field>
  )
}

/** Human label for each stylization method (drives the picker). */
const METHOD_LABELS: Record<RasterMethod, string> = {
  contours: 'Outline tracing',
  centerline: 'Centreline (line art)',
  contourmap: 'Topographic lines',
  hatch: 'Tonal hatching',
  pressurehatch: 'Pressure hatch',
  scanlines: 'Squiggle scanlines',
  tsp: 'TSP art (one line)',
  voronoi: 'Voronoi mosaic',
  flowfield: 'Flow field',
  spiral: 'Spiral',
}

function RasterInspector({ id, params }: { id: string; params: RasterParams }) {
  const setParams = useDoc((s) => s.setParams)
  // Every edit re-traces live (debounced, off-thread), so there's no manual Regenerate — just patch.
  const up = (patch: Partial<RasterParams>) => setParams(id, { ...params, ...patch })
  const m = params.method
  const seeded = SEEDED_METHODS.has(m)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))

  return (
    <>
      <SectionTitle>Image</SectionTitle>
      <GenerationNote id={id} />
      {!params.imageId && (
        <Banner variant="warn">⚠ Image data missing — re-import this image.</Banner>
      )}
      <Field label="Method" title="How the image is turned into pen strokes.">
        <select
          className={controlClass}
          value={m}
          onChange={(e) => up({ method: e.target.value as RasterMethod })}
        >
          {(Object.keys(METHOD_LABELS) as RasterMethod[]).map((k) => (
            <option key={k} value={k}>{METHOD_LABELS[k]}</option>
          ))}
        </select>
      </Field>

      {/* --- per-method controls --- */}
      {(m === 'contours' || m === 'centerline') && (
        <>
          <SliderNum label="Threshold" min={0} max={255} step={1} value={params.threshold} hardMax int
            title="Luma cutoff: pixels darker than this become ink. Lower = less ink, higher = more."
            onChange={(v) => up({ threshold: v })} />
          <SliderNum label="Smoothing (mm)" min={0} max={5} step={0.1} value={params.simplifyTol}
            title={m === 'centerline'
              ? 'Simplify the traced centrelines (mm). Higher = smoother and fewer points.'
              : 'Elastic-band smoothing strength: how far (mm) the traced line may be pulled taut from the pixel edge. 0 = faithful/jagged; higher = smoother and simpler. Sharp corners are kept.'}
            onChange={(v) => up({ simplifyTol: v })} />
        </>
      )}
      {m === 'contours' && (
        <SliderNum label="Despeckle (px²)" min={0} max={100} step={1} value={params.minArea} int
          title="Drop traced contours smaller than this many pixels² (removes specks)."
          onChange={(v) => up({ minArea: v })} />
      )}

      {m === 'contourmap' && (
        <SliderNum label="Levels" min={1} max={12} step={1} value={params.levels} hardMax int
          title="Number of evenly-spaced tone thresholds drawn as iso-lines (like a contour map)."
          onChange={(v) => up({ levels: v })} />
      )}

      {m === 'hatch' && (
        <>
          <SliderNum label="Spacing (mm)" min={0.2} max={8} step={0.1} value={params.spacing}
            title="Distance between hatch lines. Smaller = denser, darker tone." onChange={(v) => up({ spacing: v })} />
          <SliderNum label="Angle (°)" min={0} max={180} step={5} value={params.angle} hardMax
            title="Base hatch angle; successive tone bands cross it for an engraving look." onChange={(v) => up({ angle: v })} />
          <SliderNum label="Tone bands" min={1} max={16} step={1} value={params.levels} hardMax int
            title="How many darkness bands accrue cross-hatch passes, each at its own evenly-spread angle. More = finer tonal range."
            onChange={(v) => up({ levels: v })} />
        </>
      )}

      {m === 'pressurehatch' && (
        <>
          <SliderNum label="Spacing (mm)" min={0.2} max={8} step={0.1} value={params.spacing}
            title="Distance between hatch lines. Tone comes from pen pressure, not line density, so this just sets the rake's coarseness." onChange={(v) => up({ spacing: v })} />
          <SliderNum label="Angle (°)" min={0} max={180} step={5} value={params.angle} hardMax
            title="Direction of the hatch lines." onChange={(v) => up({ angle: v })} />
          <SliderNum label="Contrast" min={0} max={4} step={0.1} value={params.pressureContrast ?? 1} hardMax
            title="Stretch or compress the darkness-to-pressure range around mid grey. Above 1 boosts contrast (for flat source images); below 1 flattens it. 1 is a straight map."
            onChange={(v) => up({ pressureContrast: v })} />
          {!pressureOn && (
            <Banner variant="warn">
              This machine profile has no pen pressure, so every line plots at full strength.
            </Banner>
          )}
        </>
      )}

      {m === 'scanlines' && (
        <>
          <SliderNum label="Spacing (mm)" min={0.4} max={8} step={0.1} value={params.spacing}
            title="Distance between scanlines." onChange={(v) => up({ spacing: v })} />
          <SliderNum label="Amplitude (mm)" min={0} max={10} step={0.1} value={params.amplitude}
            title="How tall the squiggle gets in the darkest areas. Unbounded — type past the slider to let lines cross." onChange={(v) => up({ amplitude: v })} />
          <SliderNum label="Frequency" min={0.1} max={20} step={0.5} value={params.frequency}
            title="How tight the squiggle is (waves per unit length)." onChange={(v) => up({ frequency: v })} />
        </>
      )}

      {m === 'spiral' && (
        <>
          <SliderNum label="Pitch (mm)" min={0.3} max={8} step={0.1} value={params.spacing}
            title="Radial gap between successive spiral turns." onChange={(v) => up({ spacing: v })} />
          <SliderNum label="Amplitude (mm)" min={0} max={10} step={0.1} value={params.amplitude}
            title="How far the line swells in/out in the darkest areas. Unbounded — type past the slider to let turns cross." onChange={(v) => up({ amplitude: v })} />
          <SliderNum label="Frequency" min={0.1} max={20} step={0.5} value={params.frequency}
            title="How fast the line oscillates along the spiral." onChange={(v) => up({ frequency: v })} />
        </>
      )}

      {m === 'tsp' && (
        <SliderNum label="Density" min={0} max={1} step={0.01} value={params.detail} hardMax
          title="How many points the single line threads through (weighted toward dark areas). Higher = more detail but slower."
          onChange={(v) => up({ detail: v })} />
      )}
      {m === 'voronoi' && (
        <SliderNum label="Density" min={0} max={1} step={0.01} value={params.detail} hardMax
          title="How many Voronoi cells (points weighted toward dark areas). Higher = finer mosaic."
          onChange={(v) => up({ detail: v })} />
      )}

      {m === 'flowfield' && (
        <>
          <SliderNum label="Density" min={0} max={1} step={0.01} value={params.detail} hardMax
            title="How many streamlines are seeded (weighted toward dark areas)." onChange={(v) => up({ detail: v })} />
          <SliderNum label="Angle (°)" min={0} max={180} step={5} value={params.angle} hardMax
            title="Direction the flow falls back to in flat (edgeless) regions." onChange={(v) => up({ angle: v })} />
          <SliderNum label="Length" min={4} max={400} step={1} value={params.flowSteps} hardMax int
            title="Maximum streamline length (integration steps)." onChange={(v) => up({ flowSteps: v })} />
        </>
      )}

      {seeded && (
        <Field label="Seed" title="Random arrangement. Re-roll for a different one.">
          <div className="flex min-w-0 items-center gap-2">
            <input
              className={cx(controlClass, 'min-w-0 flex-1')}
              type="text"
              inputMode="numeric"
              value={params.seed}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                if (Number.isFinite(v)) up({ seed: Math.max(0, v) })
              }}
            />
            <IconButton
              aria-label="Re-roll seed"
              title="Re-roll: new random arrangement"
              onClick={() => up({ seed: Math.floor(Math.random() * 1e9) })}
            >
              <Dices size={16} />
            </IconButton>
          </div>
        </Field>
      )}

      <Field label="Invert" title="Swap ink and paper (render the light areas instead of the dark).">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={params.invert}
          onChange={(e) => up({ invert: e.target.checked })}
        />
      </Field>
      <SliderNum label="Width (mm)" min={1} max={400} step={1} value={params.targetWidthMm} int
        onChange={(v) => up({ targetWidthMm: v })} />
      <SliderNum label="Height (mm)" min={1} max={400} step={1} value={params.targetHeightMm} int
        onChange={(v) => up({ targetHeightMm: v })} />
      <Field label="Show source" title="Draw the faint source image under the strokes (display only — doesn't affect the plot).">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={params.showUnderlay}
          onChange={(e) => up({ showUnderlay: e.target.checked })}
        />
      </Field>
    </>
  )
}

/** Default colours offered when adding a pen — a readable, distinct cycle. */
const PEN_PALETTE = ['#1a1a1a', '#E5484D', '#2563EB', '#16A34A', '#D97706', '#7C3AED', '#0891B2', '#DB2777']

function PenSwatch({ color }: { color: string }) {
  return (
    <span
      className="h-3.5 w-3.5 shrink-0 rounded-sm border border-black/15"
      style={{ background: color }}
      aria-hidden
    />
  )
}

/** Assign an element (or selection) to a pen. `value === null` = a mixed selection. */
function PenSelect({ value, onChange }: { value: number | null; onChange: (pen: number) => void }) {
  const pens = useDoc((s) => s.profile.pens)
  const current = value === null ? undefined : pens.find((p) => p.id === value)
  return (
    <Field label="Pen">
      <div className="flex min-w-0 items-center gap-2">
        <PenSwatch color={current?.color ?? '#1a1a1a'} />
        <select
          className={controlClass}
          value={value ?? ''}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {value === null && <option value="">Mixed</option>}
          {pens.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </Field>
  )
}

/** Shown when 2+ elements are selected: align + group actions. */
function MultiSelectSection({ count }: { count: number }) {
  const align = useDoc((s) => s.align)
  const removeSelected = useDoc((s) => s.removeSelected)
  const duplicateSelected = useDoc((s) => s.duplicateSelected)
  const setPenSelected = useDoc((s) => s.setPenSelected)
  const setPressureSelected = useDoc((s) => s.setPressureSelected)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const booleanSelected = useDoc((s) => s.booleanSelected)
  const joinSelected = useDoc((s) => s.joinSelected)
  const convertToPath = useDoc((s) => s.convertToPath)
  const simplifySelected = useDoc((s) => s.simplifySelected)
  const nonPathCount = useDoc(
    (s) => s.elements.filter((e) => s.selectedIds.includes(e.id) && e.type !== 'path').length,
  )
  const pathCount = useDoc(
    (s) => s.elements.filter((e) => s.selectedIds.includes(e.id) && e.type === 'path').length,
  )
  // How many selected elements are closed shapes (rect/ellipse/closed path) — boolean ops need ≥2.
  const closedCount = useDoc(
    (s) =>
      s.elements.filter((e) => {
        if (!s.selectedIds.includes(e.id)) return false
        if (e.type === 'rect' || e.type === 'ellipse') return true
        if (e.type === 'path')
          return (e.params as PathParams).contours.some((c) => c.closed && c.nodes.length >= 3)
        return false
      }).length,
  )
  // The shared pen of the selection, or null when they differ (→ "Mixed"). Single-pen elements
  // only; a natively multi-colour element in the mix is ignored for this control.
  const commonPen = useDoc((s) => {
    const sel = s.elements.filter((e) => s.selectedIds.includes(e.id) && !isMultiPen(e.type))
    if (!sel.length) return null
    return sel.every((e) => e.pen === sel[0].pen) ? sel[0].pen : null
  })
  // Shared pressure of the (single-pen) selection, or null when they differ.
  const commonPressure = useDoc((s) => {
    const sel = s.elements.filter((e) => s.selectedIds.includes(e.id) && !isMultiPen(e.type))
    if (!sel.length) return null
    const first = sel[0].pressure ?? 1
    return sel.every((e) => (e.pressure ?? 1) === first) ? first : null
  })
  const A = ({ edge, Icon, title }: { edge: AlignEdge; Icon: typeof AlignStartVertical; title: string }) => (
    <IconButton aria-label={title} title={title} onClick={() => align(edge)}>
      <Icon size={16} />
    </IconButton>
  )
  return (
    <>
      <SectionTitle>{count} selected</SectionTitle>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <A edge="left" Icon={AlignStartVertical} title="Align left" />
        <A edge="centerX" Icon={AlignCenterVertical} title="Align centre (horizontal)" />
        <A edge="right" Icon={AlignEndVertical} title="Align right" />
        <span className="mx-1 h-5 w-px bg-border" />
        <A edge="top" Icon={AlignStartHorizontal} title="Align top" />
        <A edge="centerY" Icon={AlignCenterHorizontal} title="Align middle (vertical)" />
        <A edge="bottom" Icon={AlignEndHorizontal} title="Align bottom" />
      </div>
      {closedCount >= 2 && (
        <div className="mt-3">
          <SectionTitle>Combine shapes</SectionTitle>
          <div className="grid grid-cols-2 gap-1">
            <Button title="Union — merge into one shape" onClick={() => booleanSelected(0)}>
              Union
            </Button>
            <Button title="Subtract — remove the upper shapes from the bottom one" onClick={() => booleanSelected(2)}>
              Subtract
            </Button>
            <Button title="Intersect — keep only the overlap" onClick={() => booleanSelected(1)}>
              Intersect
            </Button>
            <Button title="Exclude — keep the non-overlapping parts" onClick={() => booleanSelected(3)}>
              Exclude
            </Button>
          </div>
        </div>
      )}
      {(nonPathCount > 0 || pathCount > 0) && (
        <div className="mt-3 grid grid-cols-2 gap-1">
          {nonPathCount > 0 && (
            <Button
              className={pathCount > 0 ? '' : 'col-span-2'}
              title="Convert the non-path elements in the selection into editable paths"
              onClick={() => convertToPath()}
            >
              <Spline size={15} /> To path
            </Button>
          )}
          {pathCount > 0 && (
            <Button
              className={nonPathCount > 0 ? '' : 'col-span-2'}
              title="Simplify selected paths (Ramer–Douglas–Peucker, 0.3 mm)"
              onClick={() => simplifySelected(0.3)}
            >
              Simplify
            </Button>
          )}
        </div>
      )}
      <Button
        className="mt-1 w-full"
        title="Combine into one compound path — keeps curves and open paths; overlaps become holes (use Union to merge areas instead)."
        onClick={() => joinSelected()}
      >
        <Link2 size={15} /> Combine
      </Button>
      <div className="mt-3">
        <PenSelect value={commonPen} onChange={(pen) => setPenSelected(pen)} />
        {commonPen !== null && (
          <SliderNum
            label="Pressure (%)"
            title={pressureOn ? 'Pen pressure, light to full.' : 'Machine has no variable pressure.'}
            min={0}
            max={100}
            step={1}
            int
            hardMax
            disabled={!pressureOn}
            value={Math.round((commonPressure ?? 1) * 100)}
            onChange={(v) => setPressureSelected(v / 100)}
          />
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button className="flex-1" title={`Duplicate (${MOD_KEY}D)`} onClick={() => duplicateSelected()}>
          Duplicate
        </Button>
        <Button variant="danger" title="Delete (Del)" onClick={() => removeSelected()}>
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </>
  )
}

/** The document fiducial (alignment point), if placed. Document-level, not an element — so it has
 *  its own editor rather than living in the selection-driven element UI. */
function FiducialSection() {
  const fiducial = useDoc((s) => s.fiducial)
  const setFiducial = useDoc((s) => s.setFiducial)
  const profile = useDoc((s) => s.profile)
  if (!fiducial) return null

  const r = drawableRegion(profile)
  const outOfReach = fiducial.x < r.x0 || fiducial.x > r.x1 || fiducial.y < r.y0 || fiducial.y > r.y1

  return (
    <>
      <SectionTitle title="Alignment point. At the start of a print the pen travels here at a high Z and pauses (M0) so you can register the medium before drawing.">
        Fiducial
      </SectionTitle>
      {outOfReach && (
        <Banner variant="warn">⚠ Outside the pen's reachable area — it may not be plottable.</Banner>
      )}
      <Num label="X (mm)" value={fiducial.x} step={1} onChange={(v) => setFiducial({ ...fiducial, x: v })} />
      <Num label="Y (mm)" value={fiducial.y} step={1} onChange={(v) => setFiducial({ ...fiducial, y: v })} />
      <Button variant="danger" className="mt-2 w-full" onClick={() => setFiducial(null)}>
        <Trash2 size={15} /> Remove fiducial
      </Button>
    </>
  )
}

/** Non-destructive effect stack for the selected element (any type, incl. containers). Each effect
 *  toggles, reorders, and removes; its numeric controls render generically from the registry. The
 *  source geometry is untouched — a path stays node-editable, and the canvas shows the pre-effect
 *  shape as a ghost wireframe. Edits are re-effect/re-place only (never a regenerate). */
function EffectsSection({ id, effects }: { id: string; effects: EffectSpec[] }) {
  const setEffects = useDoc((s) => s.setEffects)
  const patch = (i: number, p: Partial<Record<string, unknown>>) =>
    setEffects(id, effects.map((f, j) => (j === i ? ({ ...f, ...p } as EffectSpec) : f)))
  const remove = (i: number) => setEffects(id, effects.filter((_, j) => j !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= effects.length) return
    const next = effects.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    setEffects(id, next)
  }
  const add = (type: EffectType) => setEffects(id, [...effects, defaultEffect(type)])

  return (
    <>
      <SectionTitle>Effects</SectionTitle>
      {effects.map((f, i) => {
        const def = effectDef(f.type)
        if (!def) return null
        const val = f as unknown as Record<string, number>
        return (
          <div key={i} className="mb-2 rounded-md border border-border p-2">
            <div className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={f.enabled}
                title={f.enabled ? 'Disable effect' : 'Enable effect'}
                aria-label={f.enabled ? 'Disable effect' : 'Enable effect'}
                onChange={(e) => patch(i, { enabled: e.target.checked })}
              />
              <span className={cx('min-w-0 flex-1 truncate text-sm', !f.enabled && 'text-faint line-through')}>
                {def.label}
              </span>
              <IconButton aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </IconButton>
              <IconButton aria-label="Move down" title="Move down" disabled={i === effects.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </IconButton>
              <IconButton aria-label="Remove effect" title="Remove effect" onClick={() => remove(i)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            {f.enabled && (
              <div className="mt-2">
                {def.controls.map((c) => (
                  <SliderNum
                    key={c.key}
                    label={c.label}
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    int={c.int}
                    hardMax={!!c.int || c.key === 'strength' || c.key === 'minPressure'}
                    value={val[c.key] ?? 0}
                    onChange={(v) => patch(i, { [c.key]: v })}
                  />
                ))}
                {def.seeded && (
                  <Button
                    className="mt-1 w-full"
                    title="Re-roll the random variation"
                    onClick={() => patch(i, { seed: Math.floor(Math.random() * 1e9) })}
                  >
                    <Dices size={15} /> Re-roll
                  </Button>
                )}
              </div>
            )}
          </div>
        )
      })}
      <Field label="Add">
        <select
          className={controlClass}
          value=""
          onChange={(e) => {
            const v = e.target.value
            if (v) add(v as EffectType)
            e.target.value = ''
          }}
        >
          <option value="">Add effect…</option>
          {EFFECT_DEFS.map((d) => (
            <option key={d.type} value={d.type}>
              {d.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  )
}

function ElementSection() {
  const selectedIds = useDoc((s) => s.selectedIds)
  const element = useDoc((s) =>
    s.selectedIds.length === 1 ? (s.elements.find((e) => e.id === s.selectedIds[0]) ?? null) : null,
  )
  const setTransform = useDoc((s) => s.setTransform)
  const setPen = useDoc((s) => s.setPen)
  const setDash = useDoc((s) => s.setDash)
  const setPressure = useDoc((s) => s.setPressure)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const removeElement = useDoc((s) => s.removeElement)
  const convertToPath = useDoc((s) => s.convertToPath)
  const flipSelected = useDoc((s) => s.flipSelected)

  if (selectedIds.length === 0) {
    return (
      <div className="mt-6 flex flex-col items-center gap-2 px-4 text-center">
        <Eye size={22} className="text-faint" />
        <p className="text-xs text-muted">
          Nothing selected. Pick a tool to draw, or click an element to edit. Shift-click or drag a
          marquee to select several.
        </p>
      </div>
    )
  }

  if (selectedIds.length > 1) return <MultiSelectSection count={selectedIds.length} />
  if (!element) return null

  const t = element.transform
  return (
    <>
      {element.type === 'handwriting' && (
        <HandwritingInspector id={element.id} params={element.params as HandwritingParams} />
      )}
      {element.type === 'rect' && <RectInspector id={element.id} params={element.params as RectParams} />}
      {element.type === 'ellipse' && (
        <EllipseInspector id={element.id} params={element.params as EllipseParams} />
      )}
      {element.type === 'text' && <TextInspector id={element.id} params={element.params as TextParams} />}
      {element.type === 'generative' && (
        <GenerativeInspector id={element.id} params={element.params as GenerativeParams} />
      )}
      {element.type === 'path' && <PathInspector id={element.id} params={element.params as PathParams} />}
      {element.type === 'raster' && <RasterInspector id={element.id} params={element.params as RasterParams} />}

      {element.type !== 'path' && (
        <Button
          className="mt-3 w-full"
          title="Convert this element into editable path(s) you can node-edit"
          onClick={() => convertToPath([element.id])}
        >
          <Spline size={15} /> Convert to path
        </Button>
      )}

      {!isMultiPen(element.type) && (
        <>
          <SectionTitle>Pen</SectionTitle>
          <PenSelect value={element.pen} onChange={(pen) => setPen(element.id, pen)} />
        </>
      )}

      {/* Pen pressure + dashed style are per-stroke properties — meaningless on a container (its
          members carry their own), so the whole Stroke section is hidden for multi-pen types. */}
      {!isMultiPen(element.type) && (
        <>
          <SectionTitle>Stroke</SectionTitle>
          <SliderNum
            label="Pressure (%)"
            title={pressureOn ? 'Pen pressure, light to full.' : 'Machine has no variable pressure.'}
            min={0}
            max={100}
            step={1}
            int
            hardMax
            disabled={!pressureOn}
            value={Math.round((element.pressure ?? 1) * 100)}
            onChange={(v) => setPressure(element.id, v / 100)}
          />
          {!pressureOn && (
            <p className="-mt-1 mb-2 text-2xs text-faint">Machine has no variable pressure.</p>
          )}
          <Field label="Dashed">
            <input
              type="checkbox"
              className="h-4 w-4 justify-self-start"
              checked={!!element.dash}
              onChange={(e) => setDash(element.id, e.target.checked ? { dash: 2, gap: 2 } : null)}
            />
          </Field>
          {element.dash && (
            <>
              <Num label="Dash (mm)" value={element.dash.dash} step={0.5}
                onChange={(v) => setDash(element.id, { dash: Math.max(0.1, v), gap: element.dash!.gap })} />
              <Num label="Gap (mm)" value={element.dash.gap} step={0.5}
                onChange={(v) => setDash(element.id, { dash: element.dash!.dash, gap: Math.max(0.1, v) })} />
            </>
          )}
        </>
      )}

      <EffectsSection id={element.id} effects={element.effects ?? []} />

      <SectionTitle>Transform</SectionTitle>
      <Num label="X (mm)" value={t.x} step={1} onChange={(v) => setTransform(element.id, { x: v })} />
      <Num label="Y (mm)" value={t.y} step={1} onChange={(v) => setTransform(element.id, { y: v })} />
      <Num label="Rotation (°)" value={t.rotation} step={1}
        onChange={(v) => setTransform(element.id, { rotation: v })} />
      <Num label="Scale X" value={t.scaleX} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleX: v })} />
      <Num label="Scale Y" value={t.scaleY} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleY: v })} />
      <Field label="Flip">
        <div className="flex gap-1">
          <IconButton
            aria-label="Flip horizontal"
            title="Flip horizontal (Shift+H)"
            onClick={() => flipSelected('x')}
          >
            <FlipHorizontal size={16} />
          </IconButton>
          <IconButton
            aria-label="Flip vertical"
            title="Flip vertical (Shift+V)"
            onClick={() => flipSelected('y')}
          >
            <FlipVertical size={16} />
          </IconButton>
        </div>
      </Field>

      <div className="mt-3 flex gap-2">
        <Button
          className="flex-1"
          title="Reset position to a visible spot near the top-left of the bed"
          onClick={() => setTransform(element.id, { x: 20, y: 20 })}
        >
          Bring into view
        </Button>
        <Button variant="danger" title="Delete (Del)" onClick={() => removeElement(element.id)}>
          <Trash2 size={15} /> Delete
        </Button>
      </div>
    </>
  )
}

/** Profile selector + library actions. Built-ins seed the working profile; "Save as" stores the
 *  current (possibly edited) profile under a name; "Update" overwrites the selected saved profile.
 *  A profile is "modified" when the working copy differs from its source (or its source is gone). */
function ProfileControls() {
  const profile = useDoc((s) => s.profile)
  const selectProfile = useDoc((s) => s.selectProfile)
  const custom = useLibrary((s) => s.customProfiles)

  const source = findBuiltinProfile(profile.id) ?? custom.find((p) => p.id === profile.id)
  const isCustom = custom.some((p) => p.id === profile.id)
  const detached = !source
  const modified = detached || hashParams(profile) !== hashParams(source)

  const saveAs = () => {
    const name = prompt('Save profile as:', profile.name || 'My machine')?.trim()
    if (!name) return
    const created = useLibrary.getState().addProfile(profile, name)
    selectProfile(created.id)
  }
  const update = () => useLibrary.getState().updateProfile(profile.id, profile)
  const rename = () => {
    const name = prompt('Rename profile:', profile.name)?.trim()
    if (!name) return
    useLibrary.getState().renameProfile(profile.id, name)
    useDoc.getState().setProfile({ name })
  }
  const remove = () => {
    if (!confirm(`Delete profile "${profile.name}"? Your current settings stay loaded but unsaved.`)) return
    useLibrary.getState().removeProfile(profile.id)
  }
  const exportProfiles = () => downloadJson('kurvengefahr-profiles', profilesFile(custom))
  const importProfiles = async () => {
    try {
      const raw = await pickJsonFile()
      if (raw == null) return
      const res = parseProfilesFile(raw)
      if (res.status === 'ok') useLibrary.getState().importProfiles(res.value)
      else if (res.status === 'unsupported') alert(`Can't import — ${res.message}. Try updating the app.`)
      else alert('That file is not a valid Kurvengefahr profiles file.')
    } catch {
      alert('Could not read that file.')
    }
  }

  return (
    <>
      <SectionTitle>Profile</SectionTitle>
      <Field label="Profile">
        <select className={controlClass} value={profile.id} onChange={(e) => selectProfile(e.target.value)}>
          {detached && <option value={profile.id}>{profile.name || 'Unsaved'} (unsaved)</option>}
          <optgroup label="Built-in">
            {PROFILE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
          {custom.length > 0 && (
            <optgroup label="Saved">
              {custom.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      {modified && (
        <Banner
          action={
            isCustom ? (
              <Button variant="primary" className="h-7 px-2.5 text-xs" onClick={update}>
                Update
              </Button>
            ) : undefined
          }
        >
          {detached ? '● Unsaved profile' : '● Modified — not saved'}
        </Banner>
      )}

      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Button className="h-7 px-2.5 text-xs" onClick={saveAs}>
          Save as…
        </Button>
        {isCustom && (
          <Button className="h-7 px-2.5 text-xs" onClick={rename}>
            Rename
          </Button>
        )}
        {isCustom && (
          <Button variant="danger" className="h-7 px-2.5 text-xs" onClick={remove}>
            <Trash2 size={13} /> Delete
          </Button>
        )}
        <span className="flex-1" />
        <IconButton aria-label="Import profiles" title="Import profiles" className="h-7 w-7" onClick={importProfiles}>
          <Upload size={14} />
        </IconButton>
        <IconButton
          aria-label="Export saved profiles"
          title="Export saved profiles"
          className="h-7 w-7"
          onClick={exportProfiles}
        >
          <Download size={14} />
        </IconButton>
      </div>
    </>
  )
}

/** Pen palette editor. Pens are document-level (live on the profile); each is a colour + name.
 *  Plotting changes pens with an M0 pause, so order/contiguity is handled by the optimizer. */
function PensSection() {
  const pens = useDoc((s) => s.profile.pens)
  const setProfile = useDoc((s) => s.setProfile)

  const update = (id: number, patch: Partial<Pen>) =>
    setProfile({ pens: pens.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  const add = () => {
    const id = pens.reduce((m, p) => Math.max(m, p.id), -1) + 1
    setProfile({
      pens: [...pens, { id, name: `Pen ${pens.length + 1}`, color: PEN_PALETTE[pens.length % PEN_PALETTE.length] }],
    })
  }
  const remove = (id: number) => {
    if (pens.length <= 1) return // always keep at least one pen
    setProfile({ pens: pens.filter((p) => p.id !== id) })
  }

  return (
    <>
      <SectionTitle title="Each pen is a manual swap: an M0 pause in the G-code. The optimizer plots one pen fully before changing to the next.">
        Pens
      </SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {pens.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <input
              type="color"
              value={p.color}
              onChange={(e) => update(p.id, { color: e.target.value })}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-0.5"
              aria-label={`${p.name} colour`}
              title="Pen colour (display only — not sent to the machine)"
            />
            <input
              type="text"
              value={p.name}
              onChange={(e) => update(p.id, { name: e.target.value })}
              className={controlClass}
              aria-label="Pen name"
            />
            <IconButton
              aria-label={`Remove ${p.name}`}
              title={pens.length <= 1 ? 'Keep at least one pen' : 'Remove pen'}
              disabled={pens.length <= 1}
              onClick={() => remove(p.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button className="mt-2 h-7 px-2.5 text-xs" onClick={add}>
        <Plus size={14} /> Add pen
      </Button>
    </>
  )
}

function MachineSection() {
  const profile = useDoc((s) => s.profile)
  const setProfile = useDoc((s) => s.setProfile)
  const pressureOn = pressureEnabled(profile)
  const errors = validateProfile(profile)

  return (
    <>
      {errors.length > 0 && (
        <Banner variant="warn">
          <ul className="flex flex-col gap-0.5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      <ProfileControls />
      <PensSection />

      <SectionTitle>Bed &amp; motion</SectionTitle>
      <Num label="Bed W (mm)" value={profile.bed.width} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, width: v } })} />
      <Num label="Bed H (mm)" value={profile.bed.height} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, height: v } })} />
      <Field label="Origin">
        <select
          className={controlClass}
          value={profile.origin}
          onChange={(e) => setProfile({ origin: e.target.value as typeof profile.origin })}
        >
          <option value="bottom-left">bottom-left</option>
          <option value="top-left">top-left</option>
        </select>
      </Field>
      <Num label="Travel (mm/min)" value={profile.feeds.travel} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, travel: v } })} />
      <Num label="Draw (mm/min)" value={profile.feeds.draw} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, draw: v } })} />

      <SectionTitle title="Pen heights. With variable pressure on, a stroke's pressure (0..100%) picks a pen-down Z between the light and full heights; off = a single pen-down height (pen up/down only), and the per-element pressure control is disabled.">
        Pen Z
      </SectionTitle>
      <Field label="Variable pressure" title="On adds a light-pressure pen-down Z; a stroke's pressure picks a height between it and Pen down Z. Off = pen up/down only.">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={pressureOn}
          onChange={(e) =>
            setProfile({
              penZ: e.target.checked
                ? { ...profile.penZ, downLight: (profile.penZ.up + profile.penZ.down) / 2 }
                : (({ downLight: _drop, ...rest }) => rest)(profile.penZ),
            })
          }
        />
      </Field>
      <Num label="Pen up Z" title="Clearance height — the pen lifts here to travel." value={profile.penZ.up} step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, up: v } })} />
      {pressureOn && (
        <Num
          label="Pen down Z (light)"
          title="Pen-down height at minimum (0%) pressure."
          value={profile.penZ.downLight ?? profile.penZ.down}
          step={0.1}
          onChange={(v) => setProfile({ penZ: { ...profile.penZ, downLight: v } })}
        />
      )}
      <Num
        label={pressureOn ? 'Pen down Z (full)' : 'Pen down Z'}
        title={
          pressureOn
            ? 'Pen-down height at full (100%) pressure.'
            : 'Pen-down height for every stroke.'
        }
        value={profile.penZ.down}
        step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, down: v } })}
      />

      <SectionTitle title="Pen tip position relative to the nozzle. Shrinks the reachable area; offsets G-code coordinates.">
        Pen offset (vs nozzle)
      </SectionTitle>
      <Num label="Offset X (mm)" value={profile.penOffset.x} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, x: v } })} />
      <Num label="Offset Y (mm)" value={profile.penOffset.y} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, y: v } })} />
      <Num label="Offset Z (mm)" value={profile.penOffset.z} step={0.1}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, z: v } })} />

      <SectionTitle>G-code</SectionTitle>
      <Field full label="Preamble">
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={4}
          value={profile.preamble}
          spellCheck={false}
          onChange={(e) => setProfile({ preamble: e.target.value })}
        />
      </Field>
      <Field full label="Postamble">
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.postamble}
          spellCheck={false}
          onChange={(e) => setProfile({ postamble: e.target.value })}
        />
      </Field>
      <Field
        full
        label="Pause"
        title="Operator pause, reused for pen swaps and the fiducial. The positioning moves are emitted automatically; this is just the stop. {message} is the context text (Prusa shows the M0 text on the LCD)."
      >
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.pause}
          spellCheck={false}
          placeholder={'G4 P500\nM0 {message}'}
          onChange={(e) => setProfile({ pause: e.target.value })}
        />
        <p className="mt-1 text-2xs text-faint">
          Emitted at pen changes (“Change to …”) and the fiducial. <code>{'{message}'}</code> = the
          context message; the lift/travel moves are added automatically.
        </p>
      </Field>

      <PhysicalPrinterSection />
    </>
  )
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-emerald-500',
  printing: 'bg-amber-500',
  paused: 'bg-amber-500',
  busy: 'bg-amber-500',
  attention: 'bg-accent-solid',
  error: 'bg-accent-solid',
  offline: 'bg-zinc-400',
}

function StatusDot({ status }: { status: PrinterStatus | null }) {
  const state = status?.state ?? 'offline'
  return (
    <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted">
      <span className={cx('h-2 w-2 rounded-full', STATUS_COLOR[state] ?? 'bg-zinc-400')} />
      <span className="capitalize">{status ? state : 'connecting…'}</span>
    </div>
  )
}

/** Optional direct-plotting binding (PrusaLink via the bridge extension). Inert by default: nothing
 *  requests access until the user clicks Connect. Lives on the profile, so it travels with it. */
function PhysicalPrinterSection() {
  const kind = useDoc((s) => s.profile.kind)
  const device = useDoc((s) => s.profile.device)
  const setProfile = useDoc((s) => s.setProfile)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [connecting, setConnecting] = useState(false)
  const [status, setStatus] = useState<PrinterStatus | null>(null)

  // Detect the extension (harmless ping — no access request) and load already-granted printers.
  useEffect(() => {
    let alive = true
    void bridgeAvailable().then((ok) => {
      if (!alive) return
      setAvailable(ok)
      if (ok) void grantedPrinters().then((ps) => alive && setPrinters(ps)).catch(() => {})
    })
    return () => {
      alive = false
    }
  }, [])

  // Live status of the bound printer while this section is open.
  const boundId = device?.transport === 'prusalink' ? device.printerId : null
  useEffect(() => {
    if (!available || !boundId) {
      setStatus(null)
      return
    }
    let alive = true
    const tick = () =>
      void printerStatus(boundId)
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null))
    tick()
    const t = setInterval(tick, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [available, boundId])

  if (kind !== 'prusa') return null

  const connect = async () => {
    setConnecting(true)
    try {
      const ps = await requestPrinters(true)
      setPrinters(ps)
      // Delight: if nothing's bound yet and exactly one printer was granted, bind it.
      if (!device && ps.length === 1) {
        setProfile({ device: { transport: 'prusalink', printerId: ps[0].id, printerName: ps[0].name } })
      }
    } catch {
      // user denied / closed the prompt — leave as-is
    } finally {
      setConnecting(false)
    }
  }

  const pick = (id: string) => {
    if (!id) {
      setProfile({ device: undefined })
      return
    }
    const name = printers.find((p) => p.id === id)?.name ?? device?.printerName ?? id
    setProfile({ device: { transport: 'prusalink', printerId: id, printerName: name } })
  }

  // Keep a bound-but-no-longer-granted printer visible so the binding doesn't silently vanish.
  const options = [...printers]
  if (device && !options.some((p) => p.id === device.printerId)) {
    options.unshift({ id: device.printerId, name: `${device.printerName} (disconnected)`, type: 'prusalink' })
  }

  return (
    <>
      <SectionTitle title="Plot directly to a PrusaLink printer via the browser extension.">
        Physical printer
      </SectionTitle>
      {available === false && (
        <Banner>
          Install the{' '}
          <a
            className="font-medium underline underline-offset-2"
            href="https://tibordp.github.io/prusalink-bridge/"
            target="_blank"
            rel="noreferrer"
          >
            PrusaLink Bridge
          </a>{' '}
          extension to plot straight to your printer.
        </Banner>
      )}
      {available && (
        <>
          <Field label="Printer">
            <select className={controlClass} value={device?.printerId ?? ''} onChange={(e) => pick(e.target.value)}>
              <option value="">None (download only)</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {device && <StatusDot status={status} />}
          <Button className="mt-1" onClick={connect} disabled={connecting}>
            <Printer size={14} />
            {connecting ? 'Connecting…' : printers.length ? 'Add / refresh printers…' : 'Connect a printer…'}
          </Button>
        </>
      )}
    </>
  )
}

// App-wide preferences (not document state) — currently just appearance. Lives in its own inspector
// tab so it's discoverable without crowding the per-element / per-machine panels.
const THEME_OPTIONS: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
]

function PreferencesSection() {
  const theme = useTheme((s) => s.theme)
  const setTheme = useTheme((s) => s.setTheme)
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Field label="Theme" full>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-3 gap-0.5 rounded-md border border-border bg-bg p-0.5"
        >
          {THEME_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              role="radio"
              aria-checked={theme === value}
              title={`${label} theme`}
              onClick={() => setTheme(value)}
              className={cx(
                'flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium',
                'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/45',
                theme === value
                  ? 'bg-surface text-text shadow-panel'
                  : 'text-muted hover:text-text',
              )}
            >
              <Icon size={14} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </Field>
    </>
  )
}

function Tab({
  active,
  onClick,
  id,
  controls,
  children,
  alert = false,
}: {
  active: boolean
  onClick: () => void
  id: string
  controls: string
  children: React.ReactNode
  /** Show a warning dot — e.g. the Machine profile has validation errors. */
  alert?: boolean
}) {
  return (
    <button
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={cx(
        '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors outline-none',
        'focus-visible:text-text',
        active
          ? 'border-accent text-text'
          : 'border-transparent text-muted hover:text-text',
      )}
    >
      {children}
      {alert && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-warn-text"
          aria-label="needs attention"
          title="This profile has problems that block plotting"
        />
      )}
    </button>
  )
}

export function Inspector() {
  const [tab, setTab] = useState<'elements' | 'machine' | 'preferences'>('elements')
  const inspectorOpen = useUI((s) => s.inspectorOpen)
  const setInspectorOpen = useUI((s) => s.setInspectorOpen)
  const machineInvalid = useDoc((s) => validateProfile(s.profile).length > 0)

  // Reveal the Elements tab whenever an element is selected or manipulated, so you never tweak the
  // canvas while looking at the Machine profile. The signal folds in the selected elements' ids +
  // transforms, so a plain selection change *and* a canvas drag/nudge both flip the tab back.
  const selectionSignal = useDoc((s) =>
    s.elements
      .filter((e) => s.selectedIds.includes(e.id))
      .map((e) => `${e.id}:${e.transform.x},${e.transform.y},${e.transform.rotation},${e.transform.scaleX},${e.transform.scaleY}`)
      .join('|'),
  )
  useEffect(() => {
    if (selectionSignal) setTab('elements')
  }, [selectionSignal])

  return (
    <aside
      className={cx(
        'z-30 flex w-[min(320px,85vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-panel',
        'fixed inset-y-0 right-0 transition-transform duration-200 ease-out',
        'md:static md:z-auto md:w-auto md:translate-x-0 md:shadow-none',
        inspectorOpen ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div
        role="tablist"
        aria-label="Inspector sections"
        className="flex shrink-0 items-center gap-1 border-b border-border px-2"
      >
        <Tab
          active={tab === 'elements'}
          onClick={() => setTab('elements')}
          id="tab-elements"
          controls="panel-elements"
        >
          Elements
        </Tab>
        <Tab
          active={tab === 'machine'}
          onClick={() => setTab('machine')}
          id="tab-machine"
          controls="panel-machine"
          alert={machineInvalid}
        >
          Machine
        </Tab>
        <Tab
          active={tab === 'preferences'}
          onClick={() => setTab('preferences')}
          id="tab-preferences"
          controls="panel-preferences"
        >
          Preferences
        </Tab>
        <span className="flex-1" />
        <IconButton
          className="md:hidden"
          onClick={() => setInspectorOpen(false)}
          aria-label="Close inspector"
          title="Close inspector"
        >
          <X size={17} />
        </IconButton>
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-3 outline-none"
      >
        {tab === 'elements' ? (
          <>
            <ElementsTree />
            <ElementSection />
            <FiducialSection />
          </>
        ) : tab === 'machine' ? (
          <MachineSection />
        ) : (
          <PreferencesSection />
        )}
      </div>
    </aside>
  )
}
