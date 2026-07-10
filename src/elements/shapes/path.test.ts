// weldContours — the endpoint-welding pass behind path boolean ops and SVG import cleanup.
// Only the pure helpers are tested; tessellation (pathGeometry/pathFill) is Rust.
import { describe, expect, it } from 'vitest'
import { cornerNode, weldContours, type Contour } from './path'

const open = (...pts: [number, number][]): Contour => ({ nodes: pts.map(([x, y]) => cornerNode(x, y)), closed: false })
const anchors = (c: Contour) => c.nodes.map((n) => [n.x, n.y])

describe('weldContours', () => {
  it('welds two open contours sharing an endpoint into one', () => {
    const out = weldContours([open([0, 0], [10, 0]), open([10, 0], [20, 0])])
    expect(out).toHaveLength(1)
    expect(out[0].closed).toBe(false)
    expect(anchors(out[0])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]) // n1 + n2 − 1 nodes, traversal order
  })

  it('reverses a tail-meets-tail contour and splices its handles onto the junction', () => {
    const b: Contour = {
      closed: false,
      nodes: [cornerNode(20, 0), { x: 10, y: 0, hinX: 1, hinY: 2, houtX: 3, houtY: 4 }],
    }
    const out = weldContours([open([0, 0], [10, 0]), b])
    expect(out).toHaveLength(1)
    expect(anchors(out[0])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ])
    // b reversed: the junction node's outgoing handle is b's tail hin.
    expect(out[0].nodes[1].houtX).toBe(1)
    expect(out[0].nodes[1].houtY).toBe(2)
  })

  it('closes a chain that loops back to its start, without a duplicate node', () => {
    const c: Contour = {
      closed: false,
      nodes: [cornerNode(5, 8), { x: 0, y: 0, hinX: 0.5, hinY: 0.6, houtX: 0, houtY: 0 }],
    }
    const out = weldContours([open([0, 0], [10, 0]), open([10, 0], [5, 8]), c])
    expect(out).toHaveLength(1)
    expect(out[0].closed).toBe(true)
    expect(anchors(out[0])).toEqual([
      [0, 0],
      [10, 0],
      [5, 8],
    ])
    // The dropped duplicate endpoint hands its incoming handle to the first node.
    expect(out[0].nodes[0].hinX).toBe(0.5)
    expect(out[0].nodes[0].hinY).toBe(0.6)
  })

  it('picks the straightest continuation at a T-junction', () => {
    const straight = open([10, 0], [20, 0])
    const perpendicular = open([10, 0], [10, 10])
    const out = weldContours([open([0, 0], [10, 0]), straight, perpendicular])
    expect(out).toHaveLength(2)
    expect(anchors(out[0])).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ])
    expect(anchors(out[1])).toEqual([
      [10, 0],
      [10, 10],
    ])
  })

  it('passes closed and single-node contours through untouched', () => {
    const closed: Contour = { nodes: [cornerNode(0, 0), cornerNode(1, 0), cornerNode(1, 1)], closed: true }
    const dot: Contour = { nodes: [cornerNode(5, 5)], closed: false }
    const input = [closed, dot, open([0, 0], [3, 0])]
    // Fewer than 2 open contours → nothing to weld, input returned as-is.
    expect(weldContours(input)).toBe(input)

    const out = weldContours([closed, open([0, 0], [3, 0]), open([3, 0], [6, 0])])
    expect(out[0]).toBe(closed)
    expect(out).toHaveLength(2)
  })

  it('only welds endpoints within the tolerance', () => {
    // 1 mm apart is well beyond the default 0.1 mm tolerance.
    const apart = weldContours([open([0, 0], [10, 0]), open([11, 0], [20, 0])])
    expect(apart).toHaveLength(2)
    const together = weldContours([open([0, 0], [10, 0]), open([10, 0], [20, 0])], 0.5)
    expect(together).toHaveLength(1)
  })
})
