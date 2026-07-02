// Ghost wireframe: for each selected element that has active effects, draw its *pre-effect* shape
// (the un-warped base geometry) faintly under the real, post-effect strokes. So a path keeps its
// editable nodes (NodeEditLayer) over a ghost of the smooth source curve, while the warped stroke is
// what actually plots — you never lose sight of what you're editing. A read-only overlay sibling to
// NodeEditLayer; it never participates in hit-testing.
import { useMemo } from 'react'
import { Group, Line } from 'react-konva'
import type { DocElement } from '../core/types'
import { useDoc } from '../store/document'
import { isContainer } from '../elements/registry'
import { baseLocal } from '../core/pipeline/clipGeometry'
import { effectiveTransform } from '../core/pipeline/place'

const hasActiveEffects = (el: DocElement) => !!el.effects?.some((f) => f.enabled)

export function GhostLayer() {
  const elements = useDoc((s) => s.elements)
  const selectedIds = useDoc((s) => s.selectedIds)

  const ghosts = useMemo(() => {
    const sel = new Set(selectedIds)
    const targets = elements.filter((e) => sel.has(e.id) && hasActiveEffects(e))
    if (!targets.length) return []
    const byId = new Map(elements.map((e) => [e.id, e]))
    const membersOf = new Map<string, DocElement[]>()
    if (targets.some((e) => isContainer(e.type)))
      for (const e of elements) if (e.parent) membersOf.set(e.parent, [...(membersOf.get(e.parent) ?? []), e])
    return targets.map((el) => ({ el, t: effectiveTransform(el, byId), geom: baseLocal(el, membersOf) }))
  }, [elements, selectedIds])

  if (!ghosts.length) return null

  return (
    <>
      {ghosts.map(({ el, t, geom }) => (
        <Group
          key={el.id}
          x={t.x}
          y={t.y}
          rotation={t.rotation}
          scaleX={t.scaleX}
          scaleY={t.scaleY}
          listening={false}
        >
          {geom.map((stroke, i) => {
            const pts: number[] = []
            for (const p of stroke.points) pts.push(p.x, p.y)
            return (
              <Line
                key={i}
                points={pts}
                stroke="#9ca3af"
                strokeWidth={1}
                strokeScaleEnabled={false}
                dash={[3, 3]}
                opacity={0.7}
                lineCap="round"
                lineJoin="round"
                listening={false}
              />
            )
          })}
        </Group>
      ))}
    </>
  )
}
