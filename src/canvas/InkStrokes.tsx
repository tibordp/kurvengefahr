// Shared canvas ink renderer for an element's / container's local geometry. Two paths:
//
//  - **Uniform** (the common case): every stroke has one pressure, so each renders as a single Konva
//    `Line` at a constant width — crisp, dash-capable, cheap. Behaviour matches the old per-node code.
//  - **Variable** (a natively variable-pressure generator like raster `pressurehatch`, and only when
//    the profile maps pressure to weight): pressure changes *along* a stroke, which one `Line` can't
//    show. We draw the ink with a single Konva `Shape` whose sceneFunc strokes each segment at its own
//    width — the same segment-by-segment approach the toolpath preview uses — so the edit view shows
//    the tonal weight. Thin per-stroke `Line`s (invisible, `hitStrokeWidth`) carry click selection.
//
// Pen width stays constant in physical mm regardless of element scale: the Shape reads its absolute
// scale and divides it out (mirroring the `Line`s' `strokeScaleEnabled={false}`). The optional `gain`
// is the element's own pressure, which `place` multiplies into every point at plot time — applied
// here too so the canvas matches what plots. Container geometry already has member gains baked, so it
// passes `gain = 1` and per-stroke pen colours (`fixedColor` omitted).
import { Fragment, useMemo } from 'react'
import { Line, Shape } from 'react-konva'
import type Konva from 'konva'
import type { Geometry } from '../core/types'
import { displayPenWidthMm } from './penWidth'

interface Props {
  geom: Geometry
  pxPerMm: number
  /** Stroke colour by pen id (used when `fixedColor` is omitted — multi-pen / container geometry). */
  colorFor: (pen: number) => string
  /** One colour for every stroke (single-pen element). Omit to colour each stroke by its own pen. */
  fixedColor?: string
  /** Whether the profile maps pressure to display weight. When false, everything draws at full width
   *  and the variable path is never taken (weight can't vary anyway). */
  pressureOn: boolean
  /** Display gain on every point's pressure (the element's own pressure). Default 1. */
  gain?: number
  /** Dashed style in mm, or null/undefined for solid. */
  dash?: { dash: number; gap: number } | null
}

const EPS = 1e-3

/** Whether any stroke's pressure varies along its length (so a single Line width can't represent it). */
function hasVaryingPressure(geom: Geometry): boolean {
  for (const s of geom) {
    let min = Infinity
    let max = -Infinity
    for (const p of s.points) {
      const v = p.pressure ?? 1
      if (v < min) min = v
      if (v > max) max = v
    }
    if (max - min > EPS) return true
  }
  return false
}

export function InkStrokes({ geom, pxPerMm, colorFor, fixedColor, pressureOn, gain = 1, dash }: Props) {
  const varying = useMemo(() => hasVaryingPressure(geom), [geom])
  const useShape = pressureOn && varying

  const dashArr = dash ? [dash.dash * pxPerMm, dash.gap * pxPerMm] : undefined

  // Uniform path: one Line per stroke, width from that stroke's own (constant) pressure × gain — so a
  // container's members each read at their own weight, matching the preview and the plot. In the
  // variable path these Lines are invisible and carry only click selection (the Shape draws the ink).
  const lines = useMemo(
    () =>
      geom.map((stroke, i) => {
        const pts: number[] = []
        for (const p of stroke.points) pts.push(p.x, p.y)
        const wMm = displayPenWidthMm((stroke.points[0]?.pressure ?? 1) * gain, pressureOn)
        return (
          <Line
            key={i}
            points={pts}
            stroke={useShape ? undefined : fixedColor ?? colorFor(stroke.pen)}
            strokeWidth={useShape ? 0 : wMm * pxPerMm}
            strokeScaleEnabled={false}
            dash={useShape ? undefined : dashArr}
            lineCap="round"
            lineJoin="round"
            hitStrokeWidth={12}
          />
        )
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geom, pxPerMm, fixedColor, colorFor, gain, pressureOn, dashArr && dashArr.join(','), useShape],
  )

  // Variable path: a single Shape strokes every segment at its own pressure-weighted width. Width and
  // dash are converted from physical mm to the node's local units by dividing out its absolute scale,
  // so pen weight is unaffected by element scale (like strokeScaleEnabled={false} on the Lines).
  const sceneFunc = useMemo(
    () => (ctx: Konva.Context, shape: Konva.Shape) => {
      // The ctx is scaled by the node's absolute scale (= pxPerMm × element scale). To render a width
      // of `mm` millimetres at a constant *physical* size (unaffected by element scale, like
      // strokeScaleEnabled={false} on the Lines), set lineWidth = mm × k: on screen that's
      // mm × k × absX = mm × pxPerMm px. Dash lengths convert the same way.
      const absX = shape.getAbsoluteScale().x || pxPerMm
      const k = pxPerMm / absX
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      if (dash) ctx.setLineDash([dash.dash * k, dash.gap * k])
      for (const s of geom) {
        if (s.points.length < 2) continue
        ctx.strokeStyle = fixedColor ?? colorFor(s.pen)
        for (let i = 1; i < s.points.length; i++) {
          const a = s.points[i - 1]
          const b = s.points[i]
          const pr = (((a.pressure ?? 1) + (b.pressure ?? 1)) / 2) * gain
          ctx.lineWidth = displayPenWidthMm(pr, true) * k
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geom, pxPerMm, fixedColor, colorFor, gain, dash && `${dash.dash}/${dash.gap}`],
  )

  if (!useShape) return <>{lines}</>
  return (
    <Fragment>
      <Shape sceneFunc={sceneFunc} listening={false} perfectDrawEnabled={false} />
      {lines}
    </Fragment>
  )
}
