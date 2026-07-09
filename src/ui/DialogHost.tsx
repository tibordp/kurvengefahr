// Renders the pending confirm/prompt request (store/dialogs.ts) as an app Modal. Mounted once in
// App, like Toaster. The Modal already handles Esc + backdrop click via onClose (→ cancel);
// Enter submits a prompt.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDialogs, type DialogRequest } from '../store/dialogs'
import { Button, Modal, controlClass } from './primitives'

function Dialog({ request }: { request: DialogRequest }) {
  const [text, setText] = useState(request.kind === 'prompt' ? request.initial : '')
  const inputRef = useRef<HTMLInputElement>(null)

  // The handlers must be referentially stable: Modal re-runs its focus effect when `onClose`
  // changes, which would steal focus from the input on every keystroke. So the live text rides a
  // ref and both callbacks depend only on the (per-dialog-stable) request.
  const textRef = useRef(text)
  textRef.current = text
  const settled = useRef(false)
  const cancel = useCallback(() => {
    if (settled.current) return
    settled.current = true
    if (request.kind === 'confirm') request.resolve(false)
    else request.resolve(null)
    useDialogs.getState()._next()
  }, [request])
  const confirm = useCallback(() => {
    if (settled.current) return
    settled.current = true
    if (request.kind === 'confirm') request.resolve(true)
    else request.resolve(textRef.current.trim() || null)
    useDialogs.getState()._next()
  }, [request])

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  return (
    <Modal title={request.title} onClose={cancel} className="max-w-sm">
      {request.kind === 'confirm' ? (
        <p className="text-sm text-muted">{request.message}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            confirm()
          }}
        >
          {request.message && <p className="mb-2 text-sm text-muted">{request.message}</p>}
          <input
            ref={inputRef}
            className={controlClass}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        </form>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={cancel}>Cancel</Button>
        <Button
          variant={request.kind === 'confirm' && request.danger ? 'danger' : 'primary'}
          disabled={request.kind === 'prompt' && !text.trim()}
          onClick={confirm}
        >
          {request.confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}

export function DialogHost() {
  const current = useDialogs((s) => s.current)
  if (!current) return null
  // Key by request id so a queued follow-up dialog mounts with fresh state.
  return <Dialog key={current.id} request={current} />
}
