// A friendly two-word default name for new documents ("Crimson Comet") — nicer to scan in the
// document menu than a pile of identical "Untitled" entries, and a small nod to the project's
// playful streak. Purely cosmetic: the doc id is the real key, so collisions don't matter. The
// name is auto-assigned and treated as litter-free until the doc has real content (see documents.ts).
const ADJECTIVES = [
  'Crimson', 'Amber', 'Cobalt', 'Verdant', 'Golden', 'Silver', 'Velvet', 'Quiet',
  'Brisk', 'Lucid', 'Gentle', 'Nimble', 'Bold', 'Wandering', 'Hidden', 'Drifting',
  'Electric', 'Faint', 'Radiant', 'Dusky', 'Frosted', 'Ember', 'Lunar', 'Solar',
  'Wild', 'Calm', 'Bright', 'Hollow', 'Restless', 'Curious', 'Looping', 'Winding',
  'Inky', 'Rapid', 'Distant', 'Humble', 'Clever', 'Mellow', 'Spry', 'Vivid',
]

const NOUNS = [
  'Comet', 'Otter', 'Canyon', 'Meadow', 'Cipher', 'Lantern', 'Harbor', 'Falcon',
  'Thicket', 'Glacier', 'Ember', 'Willow', 'Compass', 'Marble', 'Pebble', 'Heron',
  'Beacon', 'Cobble', 'Cricket', 'Maple', 'Quartz', 'Ripple', 'Spindle', 'Tangent',
  'Vortex', 'Zephyr', 'Anchor', 'Bramble', 'Cedar', 'Dune', 'Fjord', 'Grove',
  'Loop', 'Curve', 'Stroke', 'Plume', 'Sketch', 'Cinder', 'Lattice', 'Meridian',
]

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]

/** A random "Adjective Noun" name for a brand-new document. */
export const randomDocName = (): string => `${pick(ADJECTIVES)} ${pick(NOUNS)}`
