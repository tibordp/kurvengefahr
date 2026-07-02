// A container (group/clip) on the canvas: a Konva Group at the container's transform, rendering its
// composed geometry — a group's members unioned, or a clip's members ∩ mask — computed by
// elementLocalGeometry, the same function the pipeline plots. The geometry is local, so dragging /
// resizing the container just moves the Group (no recompute per frame); it's recomputed only when the
// member tree actually changes (tracked by a fingerprint).
import { memo, useMemo } from 'react'
import { Group } from 'react-konva'
import type { DocElement } from '../core/types'
import { pressureEnabled } from '../core/types'
import { generateLocal, isContainer } from '../elements/registry'
import { elementLocalGeometry } from '../core/pipeline/clipGeometry'
import { useDoc } from '../store/document'
import { useNodeInteraction } from './useNodeInteraction'
import { InkStrokes } from './InkStrokes'

interface Props {
  element: DocElement
  /** parent → members, for this and any nested containers (built once in Canvas). */
  membersOf: Map<string, DocElement[]>
  pxPerMm: number
  interactive?: boolean
}

// Stable per-object ids so the fingerprint changes when a member's generated geometry is replaced
// (param edit, or an async child's worker result) even though its params object stays the same.
const refIds = new WeakMap<object, number>()
let refCounter = 0
function refId(o: unknown): number {
  if (!o || typeof o !== 'object') return 0
  let id = refIds.get(o as object)
  if (id === undefined) {
    id = ++refCounter
    refIds.set(o as object, id)
  }
  return id
}

/** A string that changes iff the container's member tree changes geometry/position — but NOT when the
 *  container itself moves (its own transform isn't read). Drives the geometry memo. */
function containerFingerprint(containerId: string, membersOf: Map<string, DocElement[]>): string {
  const parts: string[] = []
  const walk = (id: string) => {
    for (const m of membersOf.get(id) ?? []) {
      const t = m.transform
      const g = isContainer(m.type) ? 0 : refId(generateLocal(m))
      // refId(m.effects) so a member's effect edit (a new effects array ref) re-fingerprints — its
      // generated base ref is unchanged by effects, so it wouldn't otherwise be noticed here. `dash`
      // and `pressure` are baked into the composed geometry (pressure as a place-gain), so they must
      // re-fingerprint too.
      const dash = m.dash ? `${m.dash.dash}/${m.dash.gap}` : ''
      parts.push(`${m.id},${t.x},${t.y},${t.rotation},${t.scaleX},${t.scaleY},${g},${m.clipRole ?? ''},${m.pen},${refId(m.effects)},${dash},${m.pressure ?? ''}`)
      if (isContainer(m.type)) walk(m.id)
    }
  }
  walk(containerId)
  return parts.join(';')
}

function ContainerNodeImpl({ element, membersOf, pxPerMm, interactive = true }: Props) {
  const pens = useDoc((s) => s.profile.pens)
  const pressureOn = useDoc((s) => pressureEnabled(s.profile))
  const select = useDoc((s) => s.select)
  const handlers = useNodeInteraction(element)
  // Stable across renders (only `pens` changes it) so InkStrokes' memoized draws hold.
  const colorFor = useMemo(() => (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a', [pens])

  // Double-click enters a *clip*: select its first content member so it renders raw for editing (the
  // clip's mask is the privileged member). A plain group has no privileged member — there's nothing to
  // "enter" — so it gets no double-click affordance; edit a member by selecting its row in the tree.
  const isClip = element.type === 'clip'
  const enter = () => {
    const first = (membersOf.get(element.id) ?? []).find((m) => m.clipRole !== 'mask')
    if (first) select(first.id, false)
  }

  // Include the container's own effects ref so re-fingerprinting also catches an effect edit on it.
  const fingerprint = `${containerFingerprint(element.id, membersOf)}|${refId(element.effects)}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geom = useMemo(() => elementLocalGeometry(element, membersOf), [fingerprint])

  return (
    <Group
      id={element.id}
      x={element.transform.x}
      y={element.transform.y}
      rotation={element.transform.rotation}
      scaleX={element.transform.scaleX}
      scaleY={element.transform.scaleY}
      opacity={interactive ? 1 : 0.18}
      listening={interactive}
      draggable={interactive}
      {...handlers}
      {...(isClip ? { onDblClick: enter, onDblTap: enter } : {})}
    >
      {/* Container geometry already has each member's pressure baked in (place gain in
          group/clipLocalGeometry) and carries per-stroke pens → gain 1, per-stroke colours. */}
      <InkStrokes geom={geom} pxPerMm={pxPerMm} colorFor={colorFor} pressureOn={pressureOn} />
    </Group>
  )
}

export const ContainerNode = memo(ContainerNodeImpl)
