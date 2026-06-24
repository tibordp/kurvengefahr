// Vector-shape element types. Importing this module registers `rect`, `ellipse`, and `path` with
// the element registry (side-effect imports), and re-exports their param shapes + helpers.
import './rect'
import './ellipse'
import './path'

export { defaultRectParams, type RectParams } from './rect'
export { defaultEllipseParams, type EllipseParams } from './ellipse'
export { defaultPathParams, cornerNode, type PathParams, type PathNode } from './path'
export { defaultHatch, type Hatch, type HatchPattern } from './hatch'
