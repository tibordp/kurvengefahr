// Inspector: edits the selected element's `params` (→ re-generate) and `transform` (→ re-place),
// plus the document machine profile (→ re-emit). Pure view over the store.
import { useEffect, useState } from 'react'
import { useDoc } from '../store/document'
import { useGeneration, regenerate, isElementDirty } from '../core/generation'
import { PROFILE_PRESETS } from '../store/profiles'
import { substitution_note } from '../core/wasm'
import type { DocElement } from '../core/types'
import type { HandwritingParams } from '../elements/handwriting'

function elementName(el: DocElement): string {
  if (el.type === 'handwriting') {
    const text = (el.params as HandwritingParams).text.replace(/\s+/g, ' ').trim()
    if (!text) return 'Handwriting (empty)'
    return text.length > 20 ? `“${text.slice(0, 20)}…”` : `“${text}”`
  }
  return el.type
}

/** A flat list of all elements — the reliable way to (re)select one, including an element
 *  dragged off the bed. Selection here drives the same store as clicking on the canvas. */
function ElementList() {
  const elements = useDoc((s) => s.elements)
  const selectedId = useDoc((s) => s.selectedId)
  const select = useDoc((s) => s.select)
  const removeElement = useDoc((s) => s.removeElement)
  const genStatus = useGeneration((s) => s.status)

  if (elements.length === 0) return null
  return (
    <>
      <h3>Elements</h3>
      <ul className="elist">
        {elements.map((el) => {
          const g = genStatus[el.id]
          const rowDirty = !g && isElementDirty(el.id, el.params)
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
          return (
          <li
            key={el.id}
            className={el.id === selectedId ? 'sel' : ''}
            onClick={() => select(el.id)}
          >
            <span className="name">{elementName(el)}</span>
            {badge && (
              <span className={badgeWarn ? 'badge warn' : 'badge'} title={g?.phase ?? (rowDirty ? 'edited' : '')}>
                {badge}
              </span>
            )}
            <button
              className="x"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                removeElement(el.id)
              }}
            >
              ✕
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
    <div className="field">
      <label>{label}</label>
      <input
        type="text"
        inputMode="decimal"
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
    </div>
  )
}

/** Per-element generation feedback: model load on first use, per-line progress, or an error with
 *  retry. Generation runs in a worker; the element keeps showing its previous ink meanwhile. */
function GenerationNote({ id }: { id: string }) {
  const status = useGeneration((s) => s.status[id])
  if (!status) return null
  if (status.phase === 'loading-model') {
    return <p className="note">⏳ Loading handwriting model… (first use only)</p>
  }
  if (status.phase === 'generating') {
    const { done = 0, total = 0 } = status
    return <p className="note">✎ Generating… {total > 0 ? `${done}/${total} lines` : ''}</p>
  }
  return (
    <p className="note warn">
      ⚠ Generation failed{status.message ? `: ${status.message}` : ''}.{' '}
      <button className="link" onClick={() => regenerate(id)}>Retry</button>
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
  const dirty = !busy && isElementDirty(id, params)

  return (
    <>
      <h3>Handwriting</h3>
      <GenerationNote id={id} />
      {dirty && (
        <div className="dirty">
          <span>● Edited — preview is out of date</span>
          <button className="primary" onClick={() => regenerate(id)}>Regenerate</button>
        </div>
      )}
      <div className="field full">
        <textarea
          rows={3}
          value={params.text}
          onChange={(e) => update({ text: e.target.value })}
        />
      </div>
      {subs && <p className="note warn" title="The model's alphabet is limited; these were remapped.">⚠ Substituted: {subs}</p>}
      <Num label="Font (mm)" value={params.layout.fontSizeMm} step={0.5}
        onChange={(v) => setLayout({ fontSizeMm: v })} />
      <Num label="Line height" value={params.layout.lineHeightEm} step={0.1}
        onChange={(v) => setLayout({ lineHeightEm: v })} />
      <Num label="Wrap (mm)" value={params.layout.maxWidthMm} step={5}
        onChange={(v) => setLayout({ maxWidthMm: v })} />
      <Num label="Slant (°)" value={params.layout.slantDeg} step={1}
        onChange={(v) => setLayout({ slantDeg: v })} />
      <div className="field">
        <label>Align</label>
        <select
          value={params.layout.align}
          onChange={(e) => setLayout({ align: e.target.value as HandwritingParams['layout']['align'] })}
        >
          <option value="left">left</option>
          <option value="center">center</option>
          <option value="right">right</option>
        </select>
      </div>
      <Num label="Seed" value={params.style.seed} step={1}
        onChange={(v) => setStyle({ seed: v })} />
      <div className="field">
        <label title="Neatness. Lower = looser/more natural, higher = neater and more legible.">
          Neatness
        </label>
        <div className="range">
          <input
            type="range"
            min={0}
            max={2.5}
            step={0.05}
            value={params.style.bias}
            onChange={(e) => setStyle({ bias: parseFloat(e.target.value) })}
          />
          <span className="rangeval">{params.style.bias.toFixed(2)}</span>
        </div>
      </div>
      <div className="field">
        <label title="Off: plot strokes in natural reading order (one locked unit). On: let the optimizer reorder this element's strokes with everything else.">
          Global optimize
        </label>
        <input
          type="checkbox"
          checked={params.globalOptimize}
          onChange={(e) => update({ globalOptimize: e.target.checked })}
        />
      </div>
    </>
  )
}

function ElementSection() {
  const selectedId = useDoc((s) => s.selectedId)
  const element = useDoc((s) => s.elements.find((e) => e.id === s.selectedId) ?? null)
  const setTransform = useDoc((s) => s.setTransform)
  const removeElement = useDoc((s) => s.removeElement)

  if (!element || !selectedId) {
    return <p className="empty">No selection. Add a handwriting element, then click it.</p>
  }

  const t = element.transform
  return (
    <>
      {element.type === 'handwriting' && (
        <HandwritingInspector id={element.id} params={element.params as HandwritingParams} />
      )}

      <h3>Transform</h3>
      <Num label="X (mm)" value={t.x} step={1} onChange={(v) => setTransform(element.id, { x: v })} />
      <Num label="Y (mm)" value={t.y} step={1} onChange={(v) => setTransform(element.id, { y: v })} />
      <Num label="Rotation (°)" value={t.rotation} step={1}
        onChange={(v) => setTransform(element.id, { rotation: v })} />
      <Num label="Scale X" value={t.scaleX} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleX: v })} />
      <Num label="Scale Y" value={t.scaleY} step={0.1}
        onChange={(v) => setTransform(element.id, { scaleY: v })} />

      <div className="field full" style={{ marginTop: 8, display: 'flex', gap: 6 }}>
        <button
          title="Reset position to a visible spot near the top-left of the bed"
          onClick={() => setTransform(element.id, { x: 20, y: 20 })}
        >
          Bring into view
        </button>
        <button onClick={() => removeElement(element.id)}>Delete</button>
      </div>
    </>
  )
}

function MachineSection() {
  const profile = useDoc((s) => s.profile)
  const setProfile = useDoc((s) => s.setProfile)
  const loadPreset = useDoc((s) => s.loadPreset)

  return (
    <>
      <h3>Profile</h3>
      <div className="field">
        <label>Preset</label>
        <select value={profile.id} onChange={(e) => loadPreset(e.target.value)}>
          {PROFILE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <h3>Bed &amp; motion</h3>
      <Num label="Bed W (mm)" value={profile.bed.width} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, width: v } })} />
      <Num label="Bed H (mm)" value={profile.bed.height} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, height: v } })} />
      <div className="field">
        <label>Origin</label>
        <select
          value={profile.origin}
          onChange={(e) => setProfile({ origin: e.target.value as typeof profile.origin })}
        >
          <option value="bottom-left">bottom-left</option>
          <option value="top-left">top-left</option>
        </select>
      </div>
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

      <h3 title="Pen tip position relative to the nozzle. Shrinks the reachable area; offsets G-code coordinates.">
        Pen offset (vs nozzle)
      </h3>
      <Num label="Offset X (mm)" value={profile.penOffset.x} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, x: v } })} />
      <Num label="Offset Y (mm)" value={profile.penOffset.y} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, y: v } })} />
      <Num label="Offset Z (mm)" value={profile.penOffset.z} step={0.1}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, z: v } })} />

      <h3>G-code</h3>
      <div className="field full">
        <label>Preamble</label>
        <textarea
          className="mono"
          rows={4}
          value={profile.preamble}
          spellCheck={false}
          onChange={(e) => setProfile({ preamble: e.target.value })}
        />
      </div>
      <div className="field full">
        <label>Postamble</label>
        <textarea
          className="mono"
          rows={3}
          value={profile.postamble}
          spellCheck={false}
          onChange={(e) => setProfile({ postamble: e.target.value })}
        />
      </div>
    </>
  )
}

export function Inspector() {
  const [tab, setTab] = useState<'elements' | 'machine'>('elements')
  return (
    <div className="inspector">
      <div className="tabs">
        <button
          className={tab === 'elements' ? 'active' : ''}
          onClick={() => setTab('elements')}
        >
          Elements
        </button>
        <button
          className={tab === 'machine' ? 'active' : ''}
          onClick={() => setTab('machine')}
        >
          Machine
        </button>
      </div>
      {tab === 'elements' ? (
        <>
          <ElementList />
          <ElementSection />
        </>
      ) : (
        <MachineSection />
      )}
    </div>
  )
}
