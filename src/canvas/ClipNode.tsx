// A clip on the canvas: a Konva Group at the clip's transform, rendering its *clipped* composition
// (members ∩ mask) — computed by clipLocalGeometry, the same function the pipeline plots. The
// geometry is local, so dragging/resizing the clip just moves the Group (no re-clip per frame); it's
// recomputed only when the clip's member tree actually changes (tracked by a fingerprint).
import { memo, useMemo } from 'react'
import { Group, Line } from 'react-konva'
import type { DocElement } from '../core/types'
import { generateLocal } from '../elements/registry'
import { clipLocalGeometry } from '../core/pipeline/clipGeometry'
import { useDoc } from '../store/document'
import { useNodeInteraction } from './useNodeInteraction'

interface Props {
  element: DocElement
  /** clipParent → members, for this and any nested clips (built once in Canvas). */
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

/** A string that changes iff the clip's member tree changes geometry/position — but NOT when the clip
 *  itself moves (its own transform isn't read). Drives the geometry memo. */
function clipFingerprint(clipId: string, membersOf: Map<string, DocElement[]>): string {
  const parts: string[] = []
  const walk = (id: string) => {
    for (const m of membersOf.get(id) ?? []) {
      const t = m.transform
      const g = m.type === 'clip' ? 0 : refId(generateLocal(m))
      parts.push(`${m.id},${t.x},${t.y},${t.rotation},${t.scaleX},${t.scaleY},${g},${m.clipRole ?? ''},${m.pen}`)
      if (m.type === 'clip') walk(m.id)
    }
  }
  walk(clipId)
  return parts.join(';')
}

function ClipNodeImpl({ element, membersOf, pxPerMm, interactive = true }: Props) {
  const pens = useDoc((s) => s.profile.pens)
  const select = useDoc((s) => s.select)
  const handlers = useNodeInteraction(element)
  const colorFor = (pen: number) => pens.find((p) => p.id === pen)?.color ?? '#1a1a1a'

  // Double-click enters the clip: select its first content member so it renders raw for editing.
  const enter = () => {
    const first = (membersOf.get(element.id) ?? []).find((m) => m.clipRole !== 'mask')
    if (first) select(first.id, false)
  }

  const fingerprint = clipFingerprint(element.id, membersOf)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geom = useMemo(() => clipLocalGeometry(element, membersOf), [fingerprint])

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
      onDblClick={enter}
      onDblTap={enter}
    >
      {lines}
    </Group>
  )
}

export const ClipNode = memo(ClipNodeImpl)
