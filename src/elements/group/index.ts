// The `group` element: a container whose geometry is simply its member elements composed together
// (each placed by its own group-local transform, recursing for nested containers) — computed in the
// pipeline (core/pipeline/clipGeometry.ts → groupLocalGeometry) and on the canvas by ContainerNode,
// NOT here. Like `clip` it has no generator (empty `generate` → plain sync type, never "dirty") and
// is `multiPen` so members keep their own pens. Members are normal elements tagged `parent`; a group
// (unlike a clip) has no mask. Grouping creates this with an identity transform so members keep their
// page-space positions; moving/scaling the group then transforms them all as one unit.
import { registerElement } from '../registry'

export type GroupParams = Record<string, never>

export const defaultGroupParams = (): GroupParams => ({})

registerElement('group', {
  label: 'Group',
  generate: () => [],
  multiPen: true,
  container: true,
  isLocked: () => false,
  sanitizeParams: () => ({}),
})
