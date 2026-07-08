// Per-type inspectors for the content elements: handwriting / text / generative / raster.
import { Dices } from 'lucide-react'
import { useDoc } from '../../store/document'
import { useGeneration, regenerate, needsManualRegen } from '../../core/generation'
import { substitution_note } from '../../core/wasm'
import { pressureEnabled } from '../../core/types'
import type { HandwritingParams } from '../../elements/handwriting'
import { SEEDED_METHODS, type RasterParams, type RasterMethod } from '../../elements/raster'
import {
  HERSHEY_FONTS,
  OUTLINE_FONTS,
  type TextParams,
  type TextMode,
  type TextAlign,
} from '../../elements/text'
import {
  GEN_KINDS,
  LSYSTEM_PRESETS,
  SEEDED_KINDS,
  type GenerativeParams,
  type GenKind,
} from '../../elements/generative'
import {
  Button,
  IconButton,
  Field,
  SectionTitle,
  Banner,
  controlClass,
  textareaClass,
  cx,
} from '../primitives'
import { Num, SliderNum } from './controls'
import { HatchControls } from './hatch'
import { GenerationNote } from './GenerationNote'

export function HandwritingInspector({ id, params }: { id: string; params: HandwritingParams }) {
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
      <Num label="Word gap (em)" value={params.layout.wordSpacingEm} step={0.05}
        title="Space between words, in ems of the font size."
        onChange={(v) => setLayout({ wordSpacingEm: Math.max(0, v) })} />
      <Num label="Paragraph gap (em)" value={params.layout.paragraphSpacingEm} step={0.1}
        title="Extra vertical space after a hard line break, in ems."
        onChange={(v) => setLayout({ paragraphSpacingEm: Math.max(0, v) })} />
      <Field label="Align">
        <select
          className={controlClass}
          value={params.layout.align}
          onChange={(e) => setLayout({ align: e.target.value as HandwritingParams['layout']['align'] })}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
          <option value="justify">justify</option>
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

export function GenerativeInspector({ id, params }: { id: string; params: GenerativeParams }) {
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

export function TextInspector({ id, params }: { id: string; params: TextParams }) {
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
      <Num label="Wrap (mm)" value={params.maxWidth} step={5}
        title="Wrap long lines at this width. 0 = no wrapping (break lines manually)."
        onChange={(v) => up({ maxWidth: Math.max(0, v) })} />
      <Field label="Align">
        <select className={controlClass} value={params.align} onChange={(e) => up({ align: e.target.value as TextAlign })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
          <option value="justify" disabled={params.maxWidth <= 0}>Justify</option>
        </select>
      </Field>
      {params.mode === 'outline' && (
        <HatchControls hatch={params.hatch} onChange={(h) => up({ hatch: h })} />
      )}
    </>
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

export function RasterInspector({ id, params }: { id: string; params: RasterParams }) {
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
