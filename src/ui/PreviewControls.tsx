// Preview transport: play/pause, a scrub slider over the path distance, and a speed
// multiplier. The animation loop advances the playhead by speed·dt each frame; scrubbing
// writes the same `dist`, so manual and automatic control are the same parameter.
import { useEffect } from 'react'
import { usePreview } from '../store/preview'

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
    <div className="preview-controls">
      <button onClick={onPlay} title={playing ? 'Pause' : 'Play'}>
        {playing ? '❚❚' : atEnd ? '↻' : '▶'}
      </button>
      <input
        type="range"
        min={0}
        max={total || 1}
        step={Math.max(total / 1000, 0.1)}
        value={dist}
        onChange={(e) => {
          setPlaying(false)
          setDist(parseFloat(e.target.value))
        }}
      />
      <span className="readout">
        {dist.toFixed(0)} / {total.toFixed(0)} mm
      </span>
      <select
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
