// The Machine tab: profile selector/library, pens, bed/motion, pen Z/offset, G-code, direct plotting.
import { useEffect, useState } from 'react'
import {
  Trash2,
  Upload,
  Download,
  Plus,
  MoreHorizontal,
  Save,
  Pencil,
  RotateCcw,
  RefreshCw,
  Printer,
  Cable,
} from 'lucide-react'
import { useDoc } from '../../store/document'
import { confirmDialog, promptDialog } from '../../store/dialogs'
import { toast } from '../../store/toast'
import { useLibrary } from '../../store/library'
import { useSerial, currentEbb, currentGrbl, type SerialKind } from '../../store/serial'
import { usePlotSession } from '../../store/plotSession'
import { findBuiltinProfile } from '../../store/profiles'
import { ProfilePicker } from './profilePicker'
import { hashParams } from '../../elements/registry'
import { profilesFile, parseProfilesFile } from '../../store/persistence/schema'
import { printerStatus, type PrinterStatus } from '../../output/plot'
import { useBridge, isPrinterConnected } from '../../store/bridge'
import { downloadJson, pickJsonFile } from '../../output/download'
import type { AxidrawProfile, GrblProfile, Pen, PrusaProfile } from '../../core/types'
import { pressureEnabled } from '../../core/types'
import { grblPenLines, newEmitCtx } from '../../core/pipeline/emitGrbl'
import { validateProfile } from '../../core/profileValidation'
import {
  Button,
  IconButton,
  Field,
  SectionTitle,
  Banner,
  Disclosure,
  Menu,
  MenuItem,
  MenuSeparator,
  controlClass,
  textareaClass,
  cx,
} from '../primitives'
import { Num, PEN_PALETTE } from './controls'

/** Profile selector + library actions. Built-ins seed the working profile; "Save as" stores the
 *  current (possibly edited) profile under a name; "Update" overwrites the selected saved profile.
 *  A profile is "modified" when the working copy differs from its source (or its source is gone). */
function ProfileControls() {
  const profile = useDoc((s) => s.profile)
  const selectProfile = useDoc((s) => s.selectProfile)
  const custom = useLibrary((s) => s.customProfiles)

  const source = findBuiltinProfile(profile.id) ?? custom.find((p) => p.id === profile.id)
  const isCustom = custom.some((p) => p.id === profile.id)
  const detached = !source
  const modified = detached || hashParams(profile) !== hashParams(source)

  const saveAs = async () => {
    const name = await promptDialog({ title: 'Save profile as', initial: profile.name || 'My machine' })
    if (!name) return
    const created = useLibrary.getState().addProfile(profile, name)
    selectProfile(created.id)
  }
  const update = () => useLibrary.getState().updateProfile(profile.id, profile)
  // Discard working edits by re-loading the source profile (undoable via ⌘Z). Only meaningful when
  // a source still exists (not for a detached/unsaved profile).
  const revert = () => selectProfile(profile.id)
  const rename = async () => {
    const name = await promptDialog({ title: 'Rename profile', initial: profile.name })
    if (!name) return
    useLibrary.getState().renameProfile(profile.id, name)
    useDoc.getState().setProfile({ name })
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Delete profile',
      message: `Delete "${profile.name}"? Your current settings stay loaded but unsaved.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) useLibrary.getState().removeProfile(profile.id)
  }
  const exportProfiles = () => downloadJson('kurvengefahr-profiles', profilesFile(custom))
  const importProfiles = async () => {
    try {
      const raw = await pickJsonFile()
      if (raw == null) return
      const res = parseProfilesFile(raw)
      if (res.status === 'ok') useLibrary.getState().importProfiles(res.value)
      else if (res.status === 'unsupported') toast.error(`Can't import — ${res.message}. Try updating the app.`)
      else toast.error('That file is not a valid Kurvengefahr profiles file.')
    } catch {
      toast.error('Could not read that file.')
    }
  }

  // Header-row action buttons (match the Elements tree's group/clip header buttons).
  const headerBtn = 'rounded p-1 text-muted transition-colors hover:bg-bg hover:text-text'
  return (
    <>
      {/* Actions live in the section header (like the Elements tree) — Save/Revert appear only while
          dirty, so the row is always present and nothing below ever shifts. */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <SectionTitle flush>Profile</SectionTitle>
        <div className="flex items-center gap-1">
          {modified && (
            <>
              <span
                className="h-2 w-2 rounded-full bg-accent-solid"
                title={detached ? 'Unsaved profile' : 'Unsaved changes'}
                aria-hidden
              />
              {!detached && (
                <button className={headerBtn} title="Revert to the saved profile" aria-label="Revert changes" onClick={revert}>
                  <RotateCcw size={15} />
                </button>
              )}
              <button
                className={headerBtn}
                title={isCustom ? 'Save changes to this profile' : 'Save as a new profile…'}
                aria-label={isCustom ? 'Save profile' : 'Save as new profile'}
                onClick={isCustom ? update : saveAs}
              >
                <Save size={15} />
              </button>
            </>
          )}
          <Menu
            align="right"
            trigger={({ open }) => (
              <button
                className={cx(headerBtn, open && 'bg-bg text-text')}
                aria-label="Profile actions"
                title="Profile actions"
              >
                <MoreHorizontal size={15} />
              </button>
            )}
          >
            <MenuItem onClick={saveAs}>
              <Save size={14} /> Save as new…
            </MenuItem>
            {isCustom && (
              <MenuItem onClick={rename}>
                <Pencil size={14} /> Rename…
              </MenuItem>
            )}
            {isCustom && (
              <MenuItem danger onClick={remove}>
                <Trash2 size={14} /> Delete
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem onClick={importProfiles}>
              <Upload size={14} /> Import profiles…
            </MenuItem>
            <MenuItem onClick={exportProfiles}>
              <Download size={14} /> Export profiles
            </MenuItem>
          </Menu>
        </div>
      </div>
      <ProfilePicker detached={detached} />
    </>
  )
}

/** Pen palette editor. Pens are document-level (live on the profile); each is a colour + name.
 *  Plotting changes pens with an M0 pause, so order/contiguity is handled by the optimizer. */
function PensSection() {
  const pens = useDoc((s) => s.profile.pens)
  const setProfile = useDoc((s) => s.setProfile)

  const update = (id: number, patch: Partial<Pen>) =>
    setProfile({ pens: pens.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
  const add = () => {
    const id = pens.reduce((m, p) => Math.max(m, p.id), -1) + 1
    setProfile({
      pens: [...pens, { id, name: `Pen ${pens.length + 1}`, color: PEN_PALETTE[pens.length % PEN_PALETTE.length] }],
    })
  }
  const remove = (id: number) => {
    if (pens.length <= 1) return // always keep at least one pen
    setProfile({ pens: pens.filter((p) => p.id !== id) })
  }

  return (
    <>
      <SectionTitle title="Each pen is a manual swap: an M0 pause in the G-code. The optimizer plots one pen fully before changing to the next.">
        Pens
      </SectionTitle>
      <ul className="flex flex-col gap-1.5">
        {pens.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <input
              type="color"
              value={p.color}
              onChange={(e) => update(p.id, { color: e.target.value })}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-border bg-surface p-0.5"
              aria-label={`${p.name} colour`}
              title="Pen colour (display only — not sent to the machine)"
            />
            <input
              type="text"
              value={p.name}
              onChange={(e) => update(p.id, { name: e.target.value })}
              className={controlClass}
              aria-label="Pen name"
            />
            <IconButton
              aria-label={`Remove ${p.name}`}
              title={pens.length <= 1 ? 'Keep at least one pen' : 'Remove pen'}
              disabled={pens.length <= 1}
              onClick={() => remove(p.id)}
            >
              <Trash2 size={14} />
            </IconButton>
          </li>
        ))}
      </ul>
      <Button className="mt-2 h-7 px-2.5 text-xs" onClick={add}>
        <Plus size={14} /> Add pen
      </Button>
    </>
  )
}

export function MachineSection() {
  const profile = useDoc((s) => s.profile)
  const errors = validateProfile(profile)

  return (
    <>
      {errors.length > 0 && (
        <Banner variant="warn">
          <ul className="flex flex-col gap-0.5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}
      <ProfileControls />
      {profile.kind === 'prusa' ? (
        <PrusaMachineSection profile={profile} />
      ) : profile.kind === 'axidraw' ? (
        <AxidrawMachineSection profile={profile} />
      ) : (
        <GrblMachineSection profile={profile} />
      )}
    </>
  )
}

/** Everything G-code-machine-specific: PrusaLink binding, feeds, pen Z, pen offset, G-code text. */
function PrusaMachineSection({ profile }: { profile: PrusaProfile }) {
  const setProfile = useDoc((s) => s.setProfile)
  const pressureOn = pressureEnabled(profile)

  return (
    <>
      <PhysicalPrinterSection />
      <PensSection />

      <SectionTitle>Bed &amp; motion</SectionTitle>
      <Num label="Bed W (mm)" value={profile.bed.width} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, width: v } })} />
      <Num label="Bed H (mm)" value={profile.bed.height} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, height: v } })} />
      <Field label="Origin">
        <select
          className={controlClass}
          value={profile.origin}
          onChange={(e) => setProfile({ origin: e.target.value as typeof profile.origin })}
        >
          <option value="bottom-left">bottom-left</option>
          <option value="top-left">top-left</option>
        </select>
      </Field>
      <Num label="Travel (mm/min)" value={profile.feeds.travel} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, travel: v } })} />
      <Num label="Draw (mm/min)" value={profile.feeds.draw} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, draw: v } })} />

      <SectionTitle title="Pen heights. With variable pressure on, a stroke's pressure (0..100%) picks a pen-down Z between the light and full heights; off = a single pen-down height (pen up/down only), and the per-element pressure control is disabled.">
        Pen Z
      </SectionTitle>
      <Field label="Variable pressure" title="On adds a light-pressure pen-down Z; a stroke's pressure picks a height between it and Pen down Z. Off = pen up/down only.">
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={pressureOn}
          onChange={(e) =>
            setProfile({
              penZ: e.target.checked
                ? { ...profile.penZ, downLight: (profile.penZ.up + profile.penZ.down) / 2 }
                : (({ downLight: _drop, ...rest }) => rest)(profile.penZ),
            })
          }
        />
      </Field>
      <Num label="Pen up Z" title="Clearance height — the pen lifts here to travel." value={profile.penZ.up} step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, up: v } })} />
      {pressureOn && (
        <Num
          label="Pen down Z (light)"
          title="Pen-down height at minimum (0%) pressure."
          value={profile.penZ.downLight ?? profile.penZ.down}
          step={0.1}
          onChange={(v) => setProfile({ penZ: { ...profile.penZ, downLight: v } })}
        />
      )}
      <Num
        label={pressureOn ? 'Pen down Z (full)' : 'Pen down Z'}
        title={
          pressureOn
            ? 'Pen-down height at full (100%) pressure.'
            : 'Pen-down height for every stroke.'
        }
        value={profile.penZ.down}
        step={0.1}
        onChange={(v) => setProfile({ penZ: { ...profile.penZ, down: v } })}
      />

      <SectionTitle title="Pen tip position relative to the nozzle. Shrinks the reachable area; offsets G-code coordinates.">
        Pen offset (vs nozzle)
      </SectionTitle>
      <Num label="Offset X (mm)" value={profile.penOffset.x} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, x: v } })} />
      <Num label="Offset Y (mm)" value={profile.penOffset.y} step={0.5}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, y: v } })} />
      <Num label="Offset Z (mm)" value={profile.penOffset.z} step={0.1}
        onChange={(v) => setProfile({ penOffset: { ...profile.penOffset, z: v } })} />

      <SectionTitle>G-code</SectionTitle>
      <Field full label="Preamble">
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={4}
          value={profile.preamble}
          spellCheck={false}
          onChange={(e) => setProfile({ preamble: e.target.value })}
        />
      </Field>
      <Field full label="Postamble">
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.postamble}
          spellCheck={false}
          onChange={(e) => setProfile({ postamble: e.target.value })}
        />
      </Field>
      <Field
        full
        label="Pause"
        title="Operator pause, reused for pen swaps and the fiducial. The positioning moves are emitted automatically; this is just the stop. {message} is the context text (Prusa shows the M0 text on the LCD)."
      >
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.pause}
          spellCheck={false}
          placeholder={'G4 P500\nM0 {message}'}
          onChange={(e) => setProfile({ pause: e.target.value })}
        />
        <p className="mt-1 text-2xs text-faint">
          Emitted at pen changes (“Change to …”) and the fiducial. <code>{'{message}'}</code> = the
          context message; the lift/travel moves are added automatically.
        </p>
      </Field>
    </>
  )
}

/** Everything AxiDraw-specific: work area, motion-planner limits, pen-lift servo. The machine is
 *  natively top-left-origin with no pen offset, so neither control exists for this kind. */
function AxidrawMachineSection({ profile }: { profile: AxidrawProfile }) {
  const setProfile = useDoc((s) => s.setProfile)

  return (
    <>
      <SerialDeviceSection profile={profile} />
      <PensSection />

      <SectionTitle title="Usable pen travel. The carriage is parked at the top-left corner before a plot — that corner is (0,0).">
        Work area
      </SectionTitle>
      <Num label="Width (mm)" value={profile.bed.width} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, width: v } })} />
      <Num label="Height (mm)" value={profile.bed.height} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, height: v } })} />

      <SectionTitle title="Limits for the motion planner. Speeds are along the path; acceleration bounds speed changes; cornering is how far the path may cut a corner at speed (lower = truer corners, slower plots).">
        Motion
      </SectionTitle>
      <Num label="Draw (mm/s)" value={profile.motion.drawSpeed} step={5}
        onChange={(v) => setProfile({ motion: { ...profile.motion, drawSpeed: v } })} />
      <Num label="Travel (mm/s)" value={profile.motion.travelSpeed} step={5}
        onChange={(v) => setProfile({ motion: { ...profile.motion, travelSpeed: v } })} />
      <Num label="Accel (mm/s²)" value={profile.motion.acceleration} step={50}
        onChange={(v) => setProfile({ motion: { ...profile.motion, acceleration: v } })} />
      <Num label="Cornering (mm)" title="Junction deviation: how far the path may cut a corner at speed. Lower is truer and slower."
        value={profile.motion.cornering} step={0.01}
        onChange={(v) => setProfile({ motion: { ...profile.motion, cornering: v } })} />

      <SectionTitle title="The pen-lift servo. Positions are percent of the servo's travel range; delays are how long the physical lift/drop takes before motion resumes.">
        Pen servo
      </SectionTitle>
      <Num label="Up (%)" value={profile.servo.upPercent} step={1}
        onChange={(v) => setProfile({ servo: { ...profile.servo, upPercent: v } })} />
      <Num label="Down (%)" value={profile.servo.downPercent} step={1}
        onChange={(v) => setProfile({ servo: { ...profile.servo, downPercent: v } })} />
      <Num label="Raise (ms)" value={profile.servo.liftMs} step={10}
        onChange={(v) => setProfile({ servo: { ...profile.servo, liftMs: v } })} />
      <Num label="Lower (ms)" value={profile.servo.dropMs} step={10}
        onChange={(v) => setProfile({ servo: { ...profile.servo, dropMs: v } })} />
      <ServoTest profile={profile} />
    </>
  )
}

/** Live pen-up/down toggle for dialing in the servo positions — programs the current profile
 *  percents onto the board and bounces the pen, so edits are felt immediately. Rendered even
 *  while disconnected (disabled) so the feature is discoverable before a machine is attached. */
function ServoTest({ profile }: { profile: AxidrawProfile }) {
  const connected = useSerial((s) => s.connected)
  const plotting = usePlotSession((s) => s.phase !== 'idle')
  const [penUp, setPenUp] = useState(true)

  const bounce = async (up: boolean) => {
    const ebb = currentEbb()
    if (!ebb) return
    try {
      await ebb.configureServo(profile.servo.upPercent, profile.servo.downPercent)
      await ebb.setPen(up, up ? profile.servo.liftMs : profile.servo.dropMs)
      setPenUp(up)
    } catch {
      // connection dropped mid-test — the serial store's disconnect handling takes over
    }
  }
  return (
    <Button
      className="mt-1 h-7 w-full text-xs"
      disabled={!connected || plotting}
      onClick={() => void bounce(!penUp)}
      title={
        connected
          ? 'Move the pen servo with the current Up/Down positions'
          : 'Connect the machine to test the pen'
      }
    >
      {penUp ? 'Test: lower pen' : 'Test: raise pen'}
    </Button>
  )
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400]

/** Everything GRBL-specific: connection + baud, feeds, the pen-actuation choice (Z axis vs
 *  spindle-PWM servo), homing, G-code text. Origin stays editable — GRBL plotters vary. */
function GrblMachineSection({ profile }: { profile: GrblProfile }) {
  const setProfile = useDoc((s) => s.setProfile)
  const pen = profile.pen
  const pressureOn = pressureEnabled(profile)

  const setPenMode = (mode: 'z' | 'servo') => {
    if (mode === pen.mode) return
    setProfile({
      pen:
        mode === 'z'
          ? { mode: 'z', up: 5, down: 0 }
          : { mode: 'servo', upS: 750, downS: 250, raiseMs: 300, lowerMs: 300 },
    })
  }

  return (
    <>
      <SerialDeviceSection profile={profile} />
      <Disclosure label="Advanced">
        <Field
          label="Baud rate"
          title="Must match the board's UART speed (GRBL default 115200). Changing it disconnects — reconnect after."
        >
          <select
            className={controlClass}
            value={profile.baudRate}
            onChange={(e) => {
              setProfile({ baudRate: Number(e.target.value) })
              if (useSerial.getState().connected) void useSerial.getState().disconnect()
            }}
          >
            {BAUD_RATES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </Field>
      </Disclosure>
      <PensSection />

      <SectionTitle title="Usable pen travel from the work origin. Without homing, the origin is wherever the pen sits when the job starts.">
        Bed &amp; motion
      </SectionTitle>
      <Num label="Bed W (mm)" value={profile.bed.width} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, width: v } })} />
      <Num label="Bed H (mm)" value={profile.bed.height} step={1}
        onChange={(v) => setProfile({ bed: { ...profile.bed, height: v } })} />
      <Field label="Origin">
        <select
          className={controlClass}
          value={profile.origin}
          onChange={(e) => setProfile({ origin: e.target.value as typeof profile.origin })}
        >
          <option value="bottom-left">bottom-left</option>
          <option value="top-left">top-left</option>
        </select>
      </Field>
      <Num label="Travel (mm/min)" title="Z-mode pen drops move at this feed; XY travels are G0 rapids (the firmware's $110/$111)."
        value={profile.feeds.travel} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, travel: v } })} />
      <Num label="Draw (mm/min)" value={profile.feeds.draw} step={100}
        onChange={(v) => setProfile({ feeds: { ...profile.feeds, draw: v } })} />
      <Field
        label="Home first ($H)"
        title="Only enable if the machine has limit switches — $H on a switchless machine drives into the frame. Off: the job starts (and the origin sits) wherever the pen was parked."
      >
        <input
          type="checkbox"
          className="h-4 w-4 justify-self-start"
          checked={profile.homing}
          onChange={(e) => setProfile({ homing: e.target.checked })}
        />
      </Field>

      <SectionTitle title="How the pen lifts: a real Z axis, or a servo on the spindle-PWM pin (M3 S… — the common cheap-plotter setup).">
        Pen
      </SectionTitle>
      <Field label="Actuation">
        <select className={controlClass} value={pen.mode} onChange={(e) => setPenMode(e.target.value as 'z' | 'servo')}>
          <option value="servo">Servo (spindle PWM)</option>
          <option value="z">Z axis</option>
        </select>
      </Field>
      {pen.mode === 'z' ? (
        <>
          <Field label="Variable pressure" title="On adds a light-pressure pen-down Z; a stroke's pressure picks a height between it and Pen down Z. Off = pen up/down only.">
            <input
              type="checkbox"
              className="h-4 w-4 justify-self-start"
              checked={pressureOn}
              onChange={(e) =>
                setProfile({
                  pen: e.target.checked
                    ? { ...pen, downLight: (pen.up + pen.down) / 2 }
                    : (({ downLight: _drop, ...rest }) => rest)(pen),
                })
              }
            />
          </Field>
          <Num label="Pen up Z" title="Clearance height — the pen lifts here to travel." value={pen.up} step={0.1}
            onChange={(v) => setProfile({ pen: { ...pen, up: v } })} />
          {pressureOn && (
            <Num label="Pen down Z (light)" title="Pen-down height at minimum (0%) pressure."
              value={pen.downLight ?? pen.down} step={0.1}
              onChange={(v) => setProfile({ pen: { ...pen, downLight: v } })} />
          )}
          <Num
            label={pressureOn ? 'Pen down Z (full)' : 'Pen down Z'}
            title={pressureOn ? 'Pen-down height at full (100%) pressure.' : 'Pen-down height for every stroke.'}
            value={pen.down}
            step={0.1}
            onChange={(v) => setProfile({ pen: { ...pen, down: v } })}
          />
        </>
      ) : (
        <>
          <Num label="Up (S)" title="M3 S value for pen up. What S means depends on the servo firmware — dial it in with the test button."
            value={pen.upS} step={10}
            onChange={(v) => setProfile({ pen: { ...pen, upS: v } })} />
          <Num label="Down (S)" title="M3 S value for pen down."
            value={pen.downS} step={10}
            onChange={(v) => setProfile({ pen: { ...pen, downS: v } })} />
          <Num label="Raise (ms)" title="Dwell after raising, so motion waits for the physical lift."
            value={pen.raiseMs} step={10}
            onChange={(v) => setProfile({ pen: { ...pen, raiseMs: v } })} />
          <Num label="Lower (ms)" title="Dwell after lowering."
            value={pen.lowerMs} step={10}
            onChange={(v) => setProfile({ pen: { ...pen, lowerMs: v } })} />
        </>
      )}
      <GrblPenTest profile={profile} />

      <SectionTitle>G-code</SectionTitle>
      <Field
        full
        label="Preamble"
        title="Emitted before the generated job setup (units, work zero, pen up are added automatically)."
      >
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.preamble}
          spellCheck={false}
          onChange={(e) => setProfile({ preamble: e.target.value })}
        />
      </Field>
      <Field full label="Postamble">
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={3}
          value={profile.postamble}
          spellCheck={false}
          onChange={(e) => setProfile({ postamble: e.target.value })}
        />
      </Field>
      <Field
        full
        label="Pause"
        title="Operator pause in the downloaded file, for pen swaps and the fiducial (M0 support depends on your G-code sender). Live plotting prompts in the app instead."
      >
        <textarea
          className={cx(textareaClass, 'font-mono text-xs')}
          rows={2}
          value={profile.pause}
          spellCheck={false}
          placeholder={'M0 ; {message}'}
          onChange={(e) => setProfile({ pause: e.target.value })}
        />
        <p className="mt-1 text-2xs text-faint">
          Used only in the downloaded file — live plotting pauses in the app. <code>{'{message}'}</code>{' '}
          = the context message.
        </p>
      </Field>
    </>
  )
}

/** Live pen-up/down toggle for dialing in the servo S values (or Z heights) — sends the current
 *  profile's pen lines, so edits are felt immediately. Rendered even while disconnected
 *  (disabled) so the feature is discoverable before a machine is attached. */
function GrblPenTest({ profile }: { profile: GrblProfile }) {
  const connected = useSerial((s) => s.connected)
  const plotting = usePlotSession((s) => s.phase !== 'idle')
  const [penUp, setPenUp] = useState(true)

  const bounce = async (up: boolean) => {
    const grbl = currentGrbl()
    if (!grbl) return
    try {
      for (const line of grblPenLines(profile, up ? 'up' : 'down', 1, newEmitCtx())) await grbl.send(line)
      setPenUp(up)
    } catch {
      toast.error('Pen test failed — is the machine in an alarm state? Try reconnecting.')
    }
  }
  return (
    <Button
      className="mt-1 h-7 w-full text-xs"
      disabled={!connected || plotting}
      onClick={() => void bounce(!penUp)}
      title={connected ? 'Actuate the pen with the current profile values' : 'Connect the machine to test the pen'}
    >
      {penUp ? 'Test: lower pen' : 'Test: raise pen'}
    </Button>
  )
}

/** Web Serial connection to the machine (EBB or GRBL board). Grants persist per-origin: once
 *  connected here, the toolbar's Plot button re-arms automatically on future visits (the store
 *  re-opens granted ports without a prompt). */
function SerialDeviceSection({ profile }: { profile: AxidrawProfile | GrblProfile }) {
  const supported = useSerial((s) => s.supported)
  const connected = useSerial((s) => s.connected)
  const connecting = useSerial((s) => s.connecting)
  const version = useSerial((s) => s.version)
  const setProfile = useDoc((s) => s.setProfile)
  const kind: SerialKind = profile.kind
  const baudRate = profile.kind === 'grbl' ? profile.baudRate : undefined
  const machine = profile.kind === 'axidraw' ? 'AxiDraw' : 'plotter'

  // Re-open an already-granted port whenever the section (re)opens (no prompt).
  useEffect(() => {
    void useSerial.getState().probe(kind, baudRate)
  }, [kind, baudRate])

  const connect = async () => {
    await useSerial.getState().connect(kind, baudRate)
    // The binding's presence marks the profile as plotting over Web Serial.
    if (useSerial.getState().connected && !profile.device) {
      setProfile({ device: { transport: 'webserial' } })
    }
  }

  // Trim the version banner to its meaningful tail: "EBBv13… Firmware Version 3.0.3" → "EBB 3.0.3",
  // "Grbl 1.1h ['$' for help]" → "Grbl 1.1h".
  const firmware = version?.replace(/^.*Firmware Version\s*/i, 'EBB ').replace(/\s*\[.*\]$/, '') ?? null

  return (
    <>
      <div className="mt-5 mb-1.5 flex items-center justify-between gap-2">
        <SectionTitle
          flush
          title={
            profile.kind === 'axidraw'
              ? "Plot over USB (Web Serial) to the AxiDraw's EBB board."
              : 'Stream over USB (Web Serial) to the GRBL board.'
          }
        >
          Machine connection
        </SectionTitle>
        <StatusBadge
          text={connected ? (firmware ?? 'Connected') : connecting ? 'connecting…' : 'Disconnected'}
          color={connected ? 'bg-emerald-500' : connecting ? 'bg-zinc-400' : 'bg-accent-solid'}
        />
      </div>
      {!supported ? (
        <Banner>
          This browser can’t open USB serial ports (no Web Serial support) — use a browser that
          has it to plot directly.
        </Banner>
      ) : connected ? (
        <Button className="w-full" onClick={() => void useSerial.getState().disconnect()}>
          Disconnect
        </Button>
      ) : (
        <Button className="w-full" disabled={connecting} onClick={() => void connect()}>
          <Cable size={15} /> {connecting ? 'Connecting…' : `Connect ${machine}…`}
        </Button>
      )}
    </>
  )
}

const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-emerald-500',
  printing: 'bg-amber-500',
  paused: 'bg-amber-500',
  busy: 'bg-amber-500',
  attention: 'bg-accent-solid',
  error: 'bg-accent-solid',
  offline: 'bg-zinc-400',
}

function StatusBadge({ text, color }: { text: string; color: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted">
      <span className={cx('h-2 w-2 shrink-0 rounded-full', color)} />
      <span className="capitalize">{text}</span>
    </span>
  )
}

/** Optional direct-plotting binding (PrusaLink via the Bridge for PrusaLink extension). The dropdown
 *  binds None / a granted printer; the refresh button beside it (re)requests access. A bound printer
 *  that has since vanished from the extension shows disabled + reads "Disconnected" in the header, and
 *  the toolbar's Plot button is blocked (see the shared bridge store). Inert by default — nothing
 *  requests access until the user hits refresh. The binding lives on the profile. */
function PhysicalPrinterSection() {
  const kind = useDoc((s) => s.profile.kind)
  const device = useDoc((s) => s.profile.device)
  const setProfile = useDoc((s) => s.setProfile)
  const available = useBridge((s) => s.available)
  const printers = useBridge((s) => s.printers)
  const connecting = useBridge((s) => s.connecting)
  const refresh = useBridge((s) => s.refresh)
  const [status, setStatus] = useState<PrinterStatus | null>(null)

  // Re-detect the extension + refresh the granted list whenever the section (re)opens.
  useEffect(() => {
    void useBridge.getState().probe()
  }, [])

  const binding = device?.transport === 'prusalink' ? device : undefined
  const boundId = binding?.printerId ?? null
  const connected = isPrinterConnected(boundId, available, printers)

  // Live status of the bound printer — only while it's actually reachable.
  useEffect(() => {
    if (!connected || !boundId) {
      setStatus(null)
      return
    }
    let alive = true
    const tick = () =>
      void printerStatus(boundId)
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null))
    tick()
    const t = setInterval(tick, 4000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [connected, boundId])

  if (kind !== 'prusa') return null

  const onSelect = (val: string) => {
    if (!val) {
      setProfile({ device: undefined })
      return
    }
    const name = printers.find((p) => p.id === val)?.name ?? binding?.printerName ?? val
    setProfile({ device: { transport: 'prusalink', printerId: val, printerName: name } })
  }

  const doRefresh = async () => {
    await refresh()
    // Delight: if nothing's bound and exactly one printer was granted, bind it.
    const ps = useBridge.getState().printers
    if (!device && ps.length === 1) {
      setProfile({ device: { transport: 'prusalink', printerId: ps[0].id, printerName: ps[0].name } })
    }
  }

  // Header badge: while bound, show live state — but a confirmed-gone printer reads "Disconnected"
  // (during the initial probe, `available` is null, so it reads "connecting…" rather than alarming).
  const badge = boundId
    ? connected
      ? { text: status ? status.state : 'connecting…', color: STATUS_COLOR[status?.state ?? 'offline'] ?? 'bg-zinc-400' }
      : available === null
        ? { text: 'connecting…', color: 'bg-zinc-400' }
        : { text: 'Disconnected', color: 'bg-accent-solid' }
    : null

  const boundMissing = !!boundId && !printers.some((p) => p.id === boundId)

  return (
    <>
      {/* Explicit top margin: the flush header carries no section margin of its own, so add it here
          to separate this section from Profile above. */}
      <div className="mt-5 mb-1.5 flex items-center justify-between gap-2">
        <SectionTitle flush title="Plot directly to a PrusaLink printer via the browser extension.">
          Physical printer
        </SectionTitle>
        {badge && <StatusBadge text={badge.text} color={badge.color} />}
      </div>
      {available === false ? (
        <Banner>
          Install the{' '}
          <a
            className="font-medium underline underline-offset-2"
            href="https://tibordp.github.io/prusalink-bridge/"
            target="_blank"
            rel="noreferrer"
          >
            Bridge for PrusaLink
          </a>{' '}
          extension to plot straight to your printer.
        </Banner>
      ) : available === true && printers.length === 0 && !device ? (
        // Nothing granted yet and nothing bound: a plain "Connect" button (instead of a None-only
        // dropdown) makes the consent flow the obvious next step.
        <Button className="w-full" disabled={connecting} onClick={() => void doRefresh()}>
          <Printer size={15} /> {connecting ? 'Connecting…' : 'Connect a printer…'}
        </Button>
      ) : (
        <div className="flex items-center gap-1.5">
          <select
            className={cx(controlClass, 'min-w-0 flex-1')}
            value={boundId ?? ''}
            onChange={(e) => onSelect(e.target.value)}
          >
            <option value="">None (download only)</option>
            {(printers.length > 0 || boundMissing) && (
              <optgroup label="Printers">
                {boundMissing && (
                  <option value={boundId ?? ''} disabled={available === true}>
                    {(binding?.printerName ?? boundId) + (available === true ? ' (disconnected)' : '')}
                  </option>
                )}
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <IconButton
            aria-label="Add or refresh printers"
            title="Add or refresh printers"
            className="h-8 w-8 shrink-0"
            disabled={connecting}
            onClick={() => void doRefresh()}
          >
            <RefreshCw size={15} className={cx(connecting && 'animate-spin')} />
          </IconButton>
        </div>
      )}
    </>
  )
}
