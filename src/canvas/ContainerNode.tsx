// A container (group/clip) on the canvas: a Konva Group at the container's transform, rendering its
// composed geometry — a group's members unioned, or a clip's members ∩ mask — computed by
// elementLocalGeometry, the same function the pipeline plots. The geometry is local, so dragging /
// resizing the container just moves the Group (no recompute per frame); it's recomputed only when the
// member tree actually changes (tracked by a fingerprint).
import { memo, useMemo } from 'react'
import { Group, Line } from 'react-konva'
import type { DocElement } from '../core/types'
import { generateLocal, isContainer } from '../elements/registry'
import { elementLocalGeometry } from '../core/pipeline/clipGeometry'
import { useDoc } from '../store/document'
import { useNodeInteraction } from './useNodeInteraction'

interface Props {
  element: DocElement
  /** parent → members, for this and any nested containers (built once in Canvas). */
  membersOf: Map<string, DocElement[]>
  pxPerMm: number
  interactive?: boolean
}

const PEN_WIDTH_MM = 0.4

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
      // refId(m.filters) so a member's filter edit (a new filters array ref) re-fingerprints — its
      // generated base ref is unchanged by filters, so it wouldn't otherwise be noticed here. `dash`
      // is baked into the composed geometry, so it must re-fingerprint too.
      const dash = m.dash ? `${m.dash.dash}/${m.dash.gap}` : ''
      parts.push(`${m.id},${t.x},${t.y},${t.rotation},${t.scaleX},${t.scaleY},${g},${m.clipRole ?? ''},${m.pen},${refId(m.filters)},${dash}`)
      if (isContainer(m.type)) walk(m.id)
    }
  }
  walk(containerId)
  return parts.join(';')
}

function ContainerNodeImpl({ element, membersOf, pxPerMm, interactive = true }: Props) {
  const pens = useDoc((s) => s.profile.pens)
  const select = useDoc((s) => s.select)
  const handlers = useNodeInteraction(element)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'

  // Double-click enters a *clip*: select its first content member so it renders raw for editing (the
  // clip's mask is the privileged member). A plain group has no privileged member — there's nothing to
  // "enter" — so it gets no double-click affordance; edit a member by selecting its row in the tree.
  const isClip = element.type === 'clip'
  const enter = () => {
    const first = (membersOf.get(element.id) ?? []).find((m) => m.clipRole !== 'mask')
    if (first) select(first.id, false)
  }

  // Include the container's own filters ref so re-fingerprinting also catches a filter edit on it.
  const fingerprint = `${containerFingerprint(element.id, membersOf)}|${refId(element.filters)}`
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geom = useMemo(() => elementLocalGeometry(element, membersOf), [fingerprint])

  const lines = useMemo(
    () =>
      geom.map((stroke, i) => {
        const pts: number[] = []
        for (const p of stroke.points) pts.push(p.x, p.y)
        return (
          <Line
            key={i}
            points={pts}
            stroke={colorFor(stroke.pen)}
            strokeWidth={PEN_WIDTH_MM * pxPerMm}
            strokeScaleEnabled={false}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={12}
          />
        )
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geom, pxPerMm, pens],
  )

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
      {lines}
    </Group>
  )
}

export const ContainerNode = memo(ContainerNodeImpl)
