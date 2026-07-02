// Vector-shape element types. Importing this module registers `rect`, `ellipse`, and `path` with
// the element registry (side-effect imports), and re-exports their param shapes + helpers.
import './rect'
import './ellipse'
import './polygon'
import './path'

export { defaultRectParams, type RectParams } from './rect'
export { defaultEllipseParams, type EllipseParams } from './ellipse'
export { defaultPolygonParams, polygonVertices, type PolygonParams } from './polygon'
export {
  defaultPathParams,
  cornerNode,
  pathOutlineStrokes,
  weldContours,
  type PathParams,
  type PathNode,
  type Contour,
} from './path'
export { defaultHatch, type Hatch, type HatchPattern } from './hatch'
