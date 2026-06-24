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
} from 'lucide-react'
import { useDoc, type AlignEdge } from '../store/document'
import { useUI } from '../store/ui'
import { useLibrary } from '../store/library'
import { useGeneration, regenerate, isElementDirty } from '../core/generation'
import { PROFILE_PRESETS, findBuiltinProfile } from '../store/profiles'
import { hashParams, isMultiPen } from '../elements/registry'
import { profilesFile, parseProfilesFile } from '../store/persistence/schema'
import { drawableRegion } from '../core/pipeline/clip'
import { downloadJson, pickJsonFile } from '../output/download'
import { substitution_note } from '../core/wasm'
import type { DocElement, Pen } from '../core/types'
import type { HandwritingParams } from '../elements/handwriting'
import type { RectParams, EllipseParams, PathParams, Hatch, HatchPattern } from '../elements/shapes'
import { Button, IconButton, Field, SectionTitle, Banner, controlClass, textareaClass, cx } from './primitives'
import { MOD_KEY } from './shortcuts'

function elementName(el: DocElement): string {
  if (el.type === 'handwriting') {
    const text = (el.params as HandwritingParams).text.replace(/\s+/g, ' ').trim()
    if (!text) return 'Handwriting (empty)'
    return text.length > 20 ? `“${text.slice(0, 20)}…”` : `“${text}”`
  }
  if (el.type === 'rect') return 'Rectangle'
  if (el.type === 'ellipse') return 'Ellipse'
  if (el.type === 'path') {
    const p = el.params as PathParams
    return `${p.closed ? 'Shape' : 'Path'} (${p.nodes.length})`
  }
  return el.type
}

/** A flat list of all elements — the reliable way to (re)select one, including an element
 *  dragged off the bed. Selection here drives the same store as clicking on the canvas. */
function ElementList() {
  const elements = useDoc((s) => s.elements)
  const selectedIds = useDoc((s) => s.selectedIds)
  const select = useDoc((s) => s.select)
  const removeElement = useDoc((s) => s.removeElement)
  const genStatus = useGeneration((s) => s.status)

  if (elements.length === 0) return null
  return (
    <>
      <SectionTitle>Elements</SectionTitle>
      <ul className="flex flex-col gap-1">
        {elements.map((el) => {
          const g = genStatus[el.id]
          const rowDirty = !g && isElementDirty(el.id, el.type, el.params)
          const badge =
            g?.phase === 'loading-model'
              ? '⏳'
              : g?.phase === 'generating'
                ? '✎'
                : g?.phase === 'error'
                  ? '⚠'
                  : rowDirty
                    ? '●'
                    : ''
          const badgeWarn = g?.phase === 'error' || rowDirty
          const busy = g?.phase === 'loading-model' || g?.phase === 'generating'
          const selected = selectedIds.includes(el.id)
          return (
            <li
              key={el.id}
              className={cx(
                'group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm transition-colors',
                selected
                  ? 'border-accent-border bg-accent-subtle'
                  : 'border-border hover:bg-bg',
              )}
              onClick={(e) => select(el.id, e.shiftKey || e.metaKey || e.ctrlKey)}
            >
              <span className="flex-1 truncate">{elementName(el)}</span>
              {badge && (
                <span
                  className={cx(
                    'text-2xs leading-none',
                    busy && 'animate-pulse',
                    badgeWarn ? 'text-accent-text' : 'text-muted',
                  )}
                  title={g?.phase ?? (rowDirty ? 'edited' : '')}
                >
                  {badge}
                </span>
              )}
              <button
                className="rounded p-1 text-faint opacity-60 transition-colors hover:bg-surface hover:text-accent-text sm:opacity-0 sm:group-hover:opacity-100"
                title="Delete"
                aria-label="Delete element"
                onClick={(e) => {
                  e.stopPropagation()
                  removeElement(el.id)
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

const display = (v: number) => (Number.isFinite(v) ? String(v) : '0')

// A numeric field that uses `type="text"` so intermediate states ("-", "1.", "") survive while
// typing (type="number" reports an empty value mid-typing, which clobbers negatives). It keeps
// a local string while focused and only commits valid numbers; ArrowUp/Down step like a number
// input. On blur it re-syncs to the canonical value.
function Num({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  step?: number
  onChange: (v: number) => void
}) {
  const [text, setText] = useState(() => display(value))
  const [focused, setFocused] = useState(false)

  // Mirror external changes (canvas drag, selection switch) only when not actively editing.
  useEffect(() => {
    if (!focused) setText(display(value))
  }, [value, focused])

  const stepBy = (dir: number) => {
    const base = Number.isFinite(parseFloat(text)) ? parseFloat(text) : value
    const next = Number(((Number.isFinite(base) ? base : 0) + dir * step).toFixed(6))
    setText(String(next))
    onChange(next)
  }

  return (
    <Field label={label}>
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
function GenerationNote({ id }: { id: string }) {
  const status = useGeneration((s) => s.status[id])
  if (!status) return null
  if (status.phase === 'loading-model') {
    return (
      <p className="mb-2 animate-pulse text-xs text-muted">⏳ Loading handwriting model… (first use only)</p>
    )
  }
  if (status.phase === 'generating') {
    const { done = 0, total = 0 } = status
    return (
      <p className="mb-2 animate-pulse text-xs text-muted">
        ✎ Generating… {total > 0 ? `${done}/${total} lines` : ''}
      </p>
    )
  }
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
  const dirty = !busy && isElementDirty(id, 'handwriting', params)

  return (
    <>
      <SectionTitle>Handwriting</SectionTitle>
      <GenerationNote id={id} />
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
      <Num label="Seed" value={params.style.seed} step={1}
        onChange={(v) => setStyle({ seed: v })} />
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
    </>
  )
}

/** Fill (hatch) controls shared by all closed shapes. */
function HatchControls({ hatch, onChange }: { hatch: Hatch; onChange: (h: Hatch) => void }) {
  const set = (patch: Partial<Hatch>) => onChange({ ...hatch, ...patch })
  return (
    <>
      <SectionTitle>Fill</SectionTitle>
      <Field label="Pattern">
        <select
          className={controlClass}
          value={hatch.pattern}
          onChange={(e) => set({ pattern: e.target.value as HatchPattern })}
        >
          <option value="none">None</option>
          <option value="lines">Lines</option>
          <option value="cross">Cross-hatch</option>
          <option value="grid">Grid</option>
          <option value="concentric">Concentric</option>
          <option value="hilbert">Hilbert curve</option>
        </select>
      </Field>
      {hatch.pattern !== 'none' && (
        <Num label="Density (mm)" value={hatch.spacing} step={0.5}
          onChange={(v) => set({ spacing: Math.max(0.3, v) })} />
      )}
      {(hatch.pattern === 'lines' || hatch.pattern === 'cross') && (
        <Num label="Angle (°)" value={hatch.angle} step={5} onChange={(v) => set({ angle: v })} />
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

function PathInspector({ id, params }: { id: string; params: PathParams }) {
  const setParams = useDoc((s) => s.setParams)
  return (
    <>
      <SectionTitle>Path</SectionTitle>
      <Field label="Closed">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={params.closed}
          onChange={(e) => setParams(id, { ...params, closed: e.target.checked })}
        />
      </Field>
      <p className="note text-xs text-muted">
        {params.nodes.length} node{params.nodes.length === 1 ? '' : 's'} · drag points & handles on
        the canvas to edit.
      </p>
      {params.closed && (
        <HatchControls
          hatch={params.hatch}
          onChange={(h) => setParams(id, { ...params, hatch: h })}
        />
      )}
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
  // The shared pen of the selection, or null when they differ (→ "Mixed"). Single-pen elements
  // only; a natively multi-colour element in the mix is ignored for this control.
  const commonPen = useDoc((s) => {
    const sel = s.elements.filter((e) => s.selectedIds.includes(e.id) && !isMultiPen(e.type))
    if (!sel.length) return null
    return sel.every((e) => e.pen === sel[0].pen) ? sel[0].pen : null
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
      <div className="mt-3">
        <PenSelect value={commonPen} onChange={(pen) => setPenSelected(pen)} />
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

function ElementSection() {
  const selectedIds = useDoc((s) => s.selectedIds)
  const element = useDoc((s) =>
    s.selectedIds.length === 1 ? (s.elements.find((e) => e.id === s.selectedIds[0]) ?? null) : null,
  )
  const setTransform = useDoc((s) => s.setTransform)
  const setPen = useDoc((s) => s.setPen)
  const removeElement = useDoc((s) => s.removeElement)

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
      {element.type === 'path' && <PathInspector id={element.id} params={element.params as PathParams} />}

      {!isMultiPen(element.type) && (
        <>
          <SectionTitle>Pen</SectionTitle>
          <PenSelect value={element.pen} onChange={(pen) => setPen(element.id, pen)} />
        </>
      )}

      <SectionTitle>Transform</SectionTitle>
      <Num label="X (mm)" value={t.x} step={1} onChange={(v) => setTransform(element.id, { x: v })} />
      <Num label="Y (mm)" value={t.y} step={1} onChange={(v) => setTransform(element.id, { y: v })} />
      <Num label="Rotation (°)" value={t.rotation} step={1}
        onChange={(v) => setTransform(element.id, { rotation: v })} />
      <Num label="Scale X" value={t.scaleX} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleX: v })} />
      <Num label="Scale Y" value={t.scaleY} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleY: v })} />

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

  return (
    <>
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
      <Num label="Pen up Z" value={profile.penZ.up} step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, up: v } })} />
      <Num label="Pen down Z" value={profile.penZ.down} step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, down: v } })} />
      <Num label="Dwell (ms)" value={profile.penZ.dwell} step={10}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, dwell: v } })} />

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
    </>
  )
}

function Tab({
  active,
  onClick,
  id,
  controls,
  children,
}: {
  active: boolean
  onClick: () => void
  id: string
  controls: string
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={cx(
        '-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors outline-none',
        'focus-visible:text-text',
        active
          ? 'border-accent text-text'
          : 'border-transparent text-muted hover:text-text',
      )}
    >
      {children}
    </button>
  )
}

export function Inspector() {
  const [tab, setTab] = useState<'elements' | 'machine'>('elements')
  const inspectorOpen = useUI((s) => s.inspectorOpen)
  const setInspectorOpen = useUI((s) => s.setInspectorOpen)

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
        >
          Machine
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
        id={tab === 'elements' ? 'panel-elements' : 'panel-machine'}
        aria-labelledby={tab === 'elements' ? 'tab-elements' : 'tab-machine'}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-3 outline-none"
      >
        {tab === 'elements' ? (
          <>
            <ElementList />
            <ElementSection />
            <FiducialSection />
          </>
        ) : (
          <MachineSection />
        )}
      </div>
    </aside>
  )
}
