// Inspector: edits the selected element's `params` (→ re-generate) and `transform` (→ re-place),
// plus the document machine profile (→ re-emit). Pure view over the store. On narrow viewports it
// renders as a slide-over drawer (see `useUI`); on desktop it's docked in the layout grid.
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useDoc } from '../../store/document'
import { useUI } from '../../store/ui'
import { validateProfile } from '../../core/profileValidation'
import { IconButton, cx } from '../primitives'
import { ElementsTree } from '../ElementsTree'
import { ElementSection, FiducialSection } from './elementSection'
import { MachineSection } from './machineSection'
import { PreferencesSection } from './preferencesSection'

function Tab({
  active,
  onClick,
  id,
  controls,
  children,
  alert = false,
}: {
  active: boolean
  onClick: () => void
  id: string
  controls: string
  children: React.ReactNode
  /** Show a warning dot — e.g. the Machine profile has validation errors. */
  alert?: boolean
}) {
  return (
    <button
      role="tab"
      id={id}
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
      className={cx(
        '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors outline-none',
        'focus-visible:text-text',
        active
          ? 'border-accent text-text'
          : 'border-transparent text-muted hover:text-text',
      )}
    >
      {children}
      {alert && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-warn-text"
          aria-label="needs attention"
          title="This profile has problems that block plotting"
        />
      )}
    </button>
  )
}

export function Inspector() {
  const [tab, setTab] = useState<'elements' | 'machine' | 'preferences'>('elements')
  const inspectorOpen = useUI((s) => s.inspectorOpen)
  const setInspectorOpen = useUI((s) => s.setInspectorOpen)
  const machineInvalid = useDoc((s) => validateProfile(s.profile).length > 0)

  // Reveal the Elements tab whenever an element is selected or manipulated, so you never tweak the
  // canvas while looking at the Machine profile. The signal folds in the selected elements' ids +
  // transforms, so a plain selection change *and* a canvas drag/nudge both flip the tab back.
  const selectionSignal = useDoc((s) =>
    s.elements
      .filter((e) => s.selectedIds.includes(e.id))
      .map((e) => `${e.id}:${e.transform.x},${e.transform.y},${e.transform.rotation},${e.transform.scaleX},${e.transform.scaleY}`)
      .join('|'),
  )
  useEffect(() => {
    if (selectionSignal) setTab('elements')
  }, [selectionSignal])

  return (
    <aside
      className={cx(
        'z-30 flex w-[min(320px,85vw)] flex-col overflow-hidden border-l border-border bg-surface shadow-panel',
        'fixed inset-y-0 right-0 transition-transform duration-200 ease-out',
        'md:static md:z-auto md:w-auto md:translate-x-0 md:shadow-none',
        inspectorOpen ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div
        role="tablist"
        aria-label="Inspector sections"
        className="flex shrink-0 items-center gap-1 border-b border-border px-2"
      >
        <Tab
          active={tab === 'elements'}
          onClick={() => setTab('elements')}
          id="tab-elements"
          controls="panel-elements"
        >
          Elements
        </Tab>
        <Tab
          active={tab === 'machine'}
          onClick={() => setTab('machine')}
          id="tab-machine"
          controls="panel-machine"
          alert={machineInvalid}
        >
          Machine
        </Tab>
        <Tab
          active={tab === 'preferences'}
          onClick={() => setTab('preferences')}
          id="tab-preferences"
          controls="panel-preferences"
        >
          Preferences
        </Tab>
        <span className="flex-1" />
        <IconButton
          className="md:hidden"
          onClick={() => setInspectorOpen(false)}
          aria-label="Close inspector"
          title="Close inspector"
        >
          <X size={17} />
        </IconButton>
      </div>

      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
        className="flex-1 overflow-y-auto p-3 outline-none"
      >
        {tab === 'elements' ? (
          <>
            <ElementsTree />
            <ElementSection />
            <FiducialSection />
          </>
        ) : tab === 'machine' ? (
          <MachineSection />
        ) : (
          <PreferencesSection />
        )}
      </div>
    </aside>
  )
}
