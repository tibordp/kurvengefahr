// Non-destructive effect stack editor for the selected element.
import { Trash2, ArrowUp, ArrowDown, Dices } from 'lucide-react'
import { useDoc } from '../../store/document'
import type { EffectSpec, EffectType } from '../../core/types'
import { EFFECT_DEFS, effectDef, defaultEffect } from '../../effects/registry'
import { Button, IconButton, Field, SectionTitle, controlClass, cx } from '../primitives'
import { SliderNum } from './controls'

/** Non-destructive effect stack for the selected element (any type, incl. containers). Each effect
 *  toggles, reorders, and removes; its numeric controls render generically from the registry. The
 *  source geometry is untouched — a path stays node-editable, and the canvas shows the pre-effect
 *  shape as a ghost wireframe. Edits are re-effect/re-place only (never a regenerate). */
export function EffectsSection({ id, effects }: { id: string; effects: EffectSpec[] }) {
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
