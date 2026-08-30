// Right-click / touch long-press menu over the canvas. Two shapes: actions on the clicked
// element(s), or actions on the empty background (selection + fiducial). Pure view over the
// document store — it only calls existing actions. On touch it is the *only* way to reach
// clipboard and node actions (no keyboard, no palette shortcut), so those live here too. There is deliberately **no z-ordering**: strokes have no fill, so paint order
// is invisible, and the optimizer reorders strokes for plotting anyway.
import {
  Copy,
  CirclePlus,
  Spline,
  Square,
  BoxSelect,
  ClipboardCopy,
  ClipboardPaste,
  Scissors,
  Trash2,
  Crosshair,
  MousePointer2,
  Check,
  X,
  FlipHorizontal,
  FlipVertical,
  Group,
  Ungroup,
} from 'lucide-react'
import { useDoc } from '../store/document'
import { isMultiPen } from '../elements/registry'
import { MOD_KEY } from '../ui/shortcuts'
import { ContextMenu, MenuItem, MenuSeparator, MenuLabel } from '../ui/primitives'
import { copySelectionToClipboard, cutSelectionToClipboard, pasteFromClipboard } from '../store/clipboard'
import {
  useNodeSelection,
  deleteSelectedNodes,
  selectedNodesSummary,
  setSelectedNodesSmooth,
  insertNodeOnSegment,
} from './nodeSelection'

export interface CanvasMenuState {
  x: number
  y: number
  /** Page-mm position of the click (for "place fiducial here"). */
  page: { x: number; y: number }
  /** The element under the cursor, or null for a background click. */
  targetId: string | null
  /** Opened on a segment's midpoint dot of `targetId` (a path): offer to insert a node there. */
  segment?: { ci: number; seg: number }
}

function PenSwatch({ color }: { color: string }) {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-sm border border-black/15"
      style={{ background: color }}
      aria-hidden
    />
  )
}

export function CanvasContextMenu({ menu, onClose }: { menu: CanvasMenuState; onClose: () => void }) {
  const elements = useDoc((s) => s.elements)
  const selectedIds = useDoc((s) => s.selectedIds)
  const fiducial = useDoc((s) => s.fiducial)
  const pens = useDoc((s) => s.profile.pens)
  const nodeSels = useNodeSelection((s) => s.sels)

  const d = useDoc.getState
  const shortcut = (k: string) => <span className="ml-auto shrink-0 whitespace-nowrap pl-4 text-2xs text-faint">{k}</span>

  if (menu.targetId != null) {
    // Element menu. Selection was resolved on the right-click (mousedown), so act on the selection.
    const selected = elements.filter((e) => selectedIds.includes(e.id))
    const canGroup = selected.length >= 2
    const singleGroup = selected.length === 1 && selected[0].type === 'group' ? selected[0].id : null
    const singlePen = selected.filter((e) => !isMultiPen(e.type))
    const commonPen =
      singlePen.length && singlePen.every((e) => e.pen === singlePen[0].pen) ? singlePen[0].pen : null

    // Path editing. Selected control points of the target (all node selections belong to one
    // element): Delete targets them instead of the whole element, exactly like the Del key; the
    // corner/smooth toggle applies to all of them. Opened on a segment midpoint: insert there. A
    // lone path also gets the control-points ⇄ whole-path-box switch (otherwise only reachable by
    // clicking the body again).
    const target = selected.length === 1 ? selected[0] : null
    const nodeSummary = target?.type === 'path' && nodeSels.length ? selectedNodesSummary(target.id) : null
    const selectedNodes = nodeSummary?.count ?? 0
    const nodesLabel = selectedNodes === 1 ? 'node' : `${selectedNodes} nodes`
    const transforming = target ? useDoc.getState().transformPathId === target.id : false

    return (
      <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
        {(menu.segment || selectedNodes > 0 || target?.type === 'path') && (
          <>
            {menu.segment && (
              <MenuItem onClick={() => insertNodeOnSegment(menu.targetId!, menu.segment!.ci, menu.segment!.seg)}>
                <CirclePlus size={15} /> Insert node here
              </MenuItem>
            )}
            {selectedNodes > 0 && (
              <>
                <MenuItem onClick={() => setSelectedNodesSmooth(!!nodeSummary!.allCorner)}>
                  {nodeSummary!.allCorner ? <Spline size={15} /> : <Square size={15} />}
                  {nodeSummary!.allCorner ? 'Make smooth' : 'Make corner'}
                  {selectedNodes === 1 && shortcut('Dbl-click')}
                </MenuItem>
                <MenuItem danger onClick={() => deleteSelectedNodes()}>
                  <Trash2 size={15} /> Delete {nodesLabel}
                  {shortcut('Del')}
                </MenuItem>
              </>
            )}
            {target?.type === 'path' && (
              <MenuItem onClick={() => d().togglePathTransform(target.id)}>
                <BoxSelect size={15} /> {transforming ? 'Edit points' : 'Transform whole path'}
              </MenuItem>
            )}
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={() => d().duplicateSelected()}>
          <Copy size={15} /> Duplicate
          {shortcut(`${MOD_KEY}D`)}
        </MenuItem>
        <MenuItem onClick={() => void copySelectionToClipboard()}>
          <ClipboardCopy size={15} /> Copy
          {shortcut(`${MOD_KEY}C`)}
        </MenuItem>
        <MenuItem onClick={() => void cutSelectionToClipboard()}>
          <Scissors size={15} /> Cut
          {shortcut(`${MOD_KEY}X`)}
        </MenuItem>
        <MenuItem onClick={() => void pasteFromClipboard()}>
          <ClipboardPaste size={15} /> Paste
          {shortcut(`${MOD_KEY}V`)}
        </MenuItem>
        <MenuItem danger onClick={() => d().removeSelected()}>
          <Trash2 size={15} /> Delete
          {selectedNodes === 0 && shortcut('Del')}
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => d().flipSelected('x')}>
          <FlipHorizontal size={15} /> Flip horizontal
          <span className="ml-auto pl-4 text-2xs text-faint">⇧H</span>
        </MenuItem>
        <MenuItem onClick={() => d().flipSelected('y')}>
          <FlipVertical size={15} /> Flip vertical
          <span className="ml-auto pl-4 text-2xs text-faint">⇧V</span>
        </MenuItem>
        {(canGroup || singleGroup) && (
          <>
            <MenuSeparator />
            {canGroup && (
              <MenuItem onClick={() => d().createGroup(selectedIds)}>
                <Group size={15} /> Group
              </MenuItem>
            )}
            {singleGroup && (
              <MenuItem onClick={() => d().ungroup(singleGroup)}>
                <Ungroup size={15} /> Ungroup
              </MenuItem>
            )}
          </>
        )}
        {singlePen.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Assign pen</MenuLabel>
            {pens.map((p) => (
              <MenuItem key={p.id} onClick={() => d().setPenSelected(p.id)}>
                <PenSwatch color={p.color} />
                <span className="truncate">{p.name}</span>
                {p.id === commonPen && <Check size={14} className="ml-auto text-accent-text" />}
              </MenuItem>
            ))}
          </>
        )}
      </ContextMenu>
    )
  }

  // Background menu.
  const hasElements = elements.length > 0
  const hasSelection = selectedIds.length > 0
  return (
    <ContextMenu x={menu.x} y={menu.y} onClose={onClose}>
      <MenuItem
        disabled={!hasElements}
        onClick={() => d().selectMany(elements.map((e) => e.id))}
      >
        <MousePointer2 size={15} /> Select all
      </MenuItem>
      <MenuItem disabled={!hasSelection} onClick={() => d().clearSelection()}>
        <X size={15} /> Deselect
      </MenuItem>
      <MenuItem onClick={() => void pasteFromClipboard()}>
        <ClipboardPaste size={15} /> Paste
        {shortcut(`${MOD_KEY}V`)}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => d().setFiducial({ x: menu.page.x, y: menu.page.y })}>
        <Crosshair size={15} /> {fiducial ? 'Move fiducial here' : 'Place fiducial here'}
      </MenuItem>
      {fiducial && (
        <MenuItem danger onClick={() => d().setFiducial(null)}>
          <Trash2 size={15} /> Remove fiducial
        </MenuItem>
      )}
    </ContextMenu>
  )
}
