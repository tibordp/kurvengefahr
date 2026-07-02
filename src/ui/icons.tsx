// Custom line-art icons in lucide's visual language (24×24 viewBox, currentColor stroke, round
// joins) for cases lucide doesn't cover. Each takes a `size` like a lucide icon, so it drops into
// the same slots (tool palette, buttons).
import type { ComponentProps } from 'react'

/** A small pentagon + star mark for the unified Polygon/Star tool (the tool defaults to a polygon;
 *  the Star toggle in the inspector turns it into a star). */
export function PolygonStarIcon({
  size = 24,
  ...props
}: { size?: number | string } & Omit<ComponentProps<'svg'>, 'size'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {/* pentagon (top-left) */}
      <path d="M8 2.5 13.2 6.3 11.2 12.5 4.8 12.5 2.8 6.3Z" />
      {/* five-point star (bottom-right) */}
      <path d="M16 10.5 17.4 14.1 21.2 14.3 18.2 16.7 19.2 20.5 16 18.3 12.8 20.5 13.8 16.7 10.8 14.3 14.7 14.1Z" />
    </svg>
  )
}
