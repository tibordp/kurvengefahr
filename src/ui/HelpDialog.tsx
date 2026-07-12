// The Help / About dialog: a short description, links to the docs and the source, and the
// keyboard-shortcut reference (the discoverable home for the bindings that also appear in button
// tooltips). Opened from the toolbar's help button or the `?` key; state lives in `useUI`. The
// share viewer shows it too (its help button), minus the editor shortcuts.
import { BookOpen } from 'lucide-react'
import type { ReactNode } from 'react'
import { useUI } from '../store/ui'
import { Modal } from './primitives'
import { SHORTCUT_GROUPS } from './shortcuts'

export const REPO_URL = 'https://github.com/tibordp/kurvengefahr'
const DOCS_URL = `${REPO_URL}/tree/main/docs`

/** A keycap-styled chip for a single key in the shortcuts table. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-bg px-1.5 font-mono text-2xs text-muted">
      {children}
    </kbd>
  )
}

/** GitHub mark — inlined (this lucide build has no brand icons), `currentColor`. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** An external-link button (docs, source). */
function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text outline-none transition-colors hover:bg-bg focus-visible:ring-2 focus-visible:ring-accent/45"
    >
      {children}
      <span aria-hidden className="text-faint">
        ↗
      </span>
    </a>
  )
}

/** `shortcuts` hides the keyboard reference where it doesn't apply (the read-only share viewer). */
export function HelpDialog({ shortcuts = true }: { shortcuts?: boolean }) {
  const open = useUI((s) => s.helpOpen)
  const setHelpOpen = useUI((s) => s.setHelpOpen)
  if (!open) return null

  return (
    <Modal title="About Kurvengefahr" onClose={() => setHelpOpen(false)}>
      <p className="-mt-1 mb-3 text-sm italic text-accent-text">“Achtung, die Kurve!”</p>
      <p className="text-sm leading-relaxed text-text">
        Browser CAM for a pen plotter. Turn handwriting (and vector shapes) into G-code in the
        browser, download it, and plot. Everything runs client-side — your documents never leave
        this device.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <LinkButton href={DOCS_URL}>
          <BookOpen size={15} />
          Read the docs
        </LinkButton>
        <LinkButton href={REPO_URL}>
          <GithubMark />
          View source on GitHub
        </LinkButton>
      </div>

      {shortcuts && (
        <>
          <h3 className="mb-2 mt-6 text-2xs font-semibold uppercase tracking-wider text-muted">
            Keyboard shortcuts
          </h3>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            {SHORTCUT_GROUPS.map((group) => (
              <section key={group.title}>
                <h4 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-faint">
                  {group.title}
                </h4>
                <dl className="flex flex-col gap-1">
                  {group.items.map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-3">
                      <dt className="text-xs text-muted">{item.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1">
                        {item.keys.map((k, i) => (
                          <Kbd key={i}>{k}</Kbd>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
