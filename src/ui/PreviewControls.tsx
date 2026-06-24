// Preview transport: play/pause, a scrub slider over the path distance, and a speed
// multiplier. The animation loop advances the playhead by speed·dt each frame; scrubbing
// writes the same `dist`, so manual and automatic control are the same parameter.
import { useEffect } from 'react'
import { Play, Pause, RotateCcw } from 'lucide-react'
import { usePreview } from '../store/preview'
import { Button, controlClass, cx } from './primitives'

const SPEEDS = [0.5, 1, 2, 4, 8]
const BASE_SPEED = 120 // mm/s at 1×

function usePlayback() {
  const playing = usePreview((s) => s.playing)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = 0
    const step = (ts: number) => {
      if (last) {
        const { dist, toolpath, speed, setDist, setPlaying } = usePreview.getState()
        const total = toolpath?.total ?? 0
        const next = dist + speed * ((ts - last) / 1000)
        if (next >= total) {
          setDist(total)
          setPlaying(false)
          return
        }
        setDist(next)
      }
      last = ts
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing])
}

export function PreviewControls() {
  const active = usePreview((s) => s.active)
  const playing = usePreview((s) => s.playing)
  const dist = usePreview((s) => s.dist)
  const total = usePreview((s) => s.toolpath?.total ?? 0)
  const speed = usePreview((s) => s.speed)
  const setDist = usePreview((s) => s.setDist)
  const setPlaying = usePreview((s) => s.setPlaying)
  const setSpeed = usePreview((s) => s.setSpeed)

  usePlayback()
  if (!active) return null

  const atEnd = dist >= total
  const onPlay = () => {
    if (atEnd) setDist(0) // replay from start
    setPlaying(!playing)
  }

  return (
    <div className="m-2 flex shrink-0 items-center gap-2.5 rounded-card border border-border bg-surface px-2.5 py-2 shadow-panel">
      <Button
        onClick={onPlay}
        className="w-9 px-0"
        aria-label={playing ? 'Pause' : atEnd ? 'Replay' : 'Play'}
        title={playing ? 'Pause' : atEnd ? 'Replay' : 'Play'}
      >
        {playing ? <Pause size={15} /> : atEnd ? <RotateCcw size={15} /> : <Play size={15} />}
      </Button>
      <input
        type="range"
        className="min-w-0 flex-1"
        min={0}
        max={total || 1}
        step={Math.max(total / 1000, 0.1)}
        value={dist}
        onChange={(e) => {
          setPlaying(false)
          setDist(parseFloat(e.target.value))
        }}
      />
      <span className="min-w-[96px] text-right font-mono text-xs tabular-nums text-muted">
        {dist.toFixed(0)} / {total.toFixed(0)} mm
      </span>
      <select
        className={cx(controlClass, 'w-auto')}
        value={speed / BASE_SPEED}
        onChange={(e) => setSpeed(parseFloat(e.target.value) * BASE_SPEED)}
        title="Playback speed"
      >
        {SPEEDS.map((m) => (
          <option key={m} value={m}>
            {m}×
          </option>
        ))}
      </select>
    </div>
  )
}
