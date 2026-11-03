// HourRange — a 0–23 hour RANGE selector producing a CONTIGUOUS hours int[]. A
// SINGLE-TRACK DUAL-THUMB range slider: two native range inputs (start, end) are
// absolutely overlaid on ONE track (see HourRange.css), with both thumbs on one
// line and the selected span highlighted (ink fill) between them. Clamping keeps
// start ≤ end. The UI model is a [start..end] span; the backend treats hours as an
// int[] filter, so we expand to the inclusive integer array on every change →
// setHours (debounced fetch).
//   presets: "새벽 제외" → [6..23] (drops 0–5); "전체(0–23)" → full 24.
// Derives the current span from selection.hours (first/last of the contiguous array;
// full 24 by default). Each range input is labeled for accessibility.
import FieldGroup from './FieldGroup.jsx'
import useStore from '../../store/useStore.js'
import './HourRange.css'

const MIN = 0
const MAX = 23

const zero2 = (n) => String(n).padStart(2, '0')

// Small ink/hairline preset chip (green-free) — replaces the old full-width green
// outline Buttons. Idle = hairline border + ink text on canvas; the chips are short
// so the two presets + the span text sit on one compact row.
function PresetChip({ onClick, children }) {
  return (
    <button
      type="button"
      className="t-caption-sm hour-range__preset"
      onClick={onClick}
      style={{
        padding: '2px 8px',
        background: 'var(--canvas)',
        color: 'var(--ink)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        cursor: 'pointer',
        fontFamily: 'var(--font)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}
const pct = (v) => ((v - MIN) / (MAX - MIN)) * 100

// Inclusive [start..end] → [start, start+1, …, end].
const rangeArray = (start, end) => {
  const out = []
  for (let h = start; h <= end; h++) out.push(h)
  return out
}

// Derive {start,end} from an hours array. Empty → full span (treated as all).
function spanOf(hours) {
  if (!hours || hours.length === 0) return { start: 0, end: 23 }
  return { start: hours[0], end: hours[hours.length - 1] }
}

// HourRange — `scope` selects which selection it reads/writes:
//   'A' (default) → selection.hours + setHours (the normal A control).
//   'B'           → selectionB.hours + setBHours (compare mode's B side).
// When scope==='B' but compare is off (selectionB null) the control renders nothing.
function HourRange({ scope = 'A' }) {
  const isB = scope === 'B'
  const hoursA = useStore((s) => s.selection.hours)
  const hoursB = useStore((s) => s.selectionB?.hours)
  const setHoursA = useStore((s) => s.setHours)
  const setHoursB = useStore((s) => s.setBHours)
  const selectionB = useStore((s) => s.selectionB)
  // Defensive: scope 'B' with compare off (selectionB null) → render nothing.
  if (isB && !selectionB) return null
  const hours = isB ? hoursB : hoursA
  const setHours = isB ? setHoursB : setHoursA
  const { start, end } = spanOf(hours)

  // Clamp so start ≤ end as either handle moves.
  const onStart = (v) => {
    const s = Math.min(Number(v), end)
    setHours(rangeArray(s, end))
  }
  const onEnd = (v) => {
    const e = Math.max(Number(v), start)
    setHours(rangeArray(start, e))
  }

  // Overlap edge case: when both thumbs sit on the same value, the start input
  // (drawn first) would be buried under the end input and become ungrabbable —
  // especially pinned at MAX, where the end thumb can't move right. Raise the
  // start input above the end input in that case so both handles stay draggable.
  const startOnTop = start >= end
  const startZ = startOnTop ? 4 : 3
  const endZ = startOnTop ? 3 : 4

  return (
    <FieldGroup label="시간대">
      {/* Current span, then the preset chips wrapping below (5 chips: 전체/새벽제외
          + 거주·출근·퇴근 시간대). Each sets the contiguous [start..end] hours. */}
      <div style={{ marginBottom: 'var(--sp-xs)' }}>
        <span className="t-body-strong" style={{ color: 'var(--ink)' }}>
          {zero2(start)} – {zero2(end)}시
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-xs)' }}>
        <PresetChip onClick={() => setHours(rangeArray(0, 23))}>전체</PresetChip>
        <PresetChip onClick={() => setHours(rangeArray(6, 23))}>새벽 제외</PresetChip>
        <PresetChip onClick={() => setHours(rangeArray(1, 4))}>거주(1-4)</PresetChip>
        <PresetChip onClick={() => setHours(rangeArray(7, 10))}>출근(7-10)</PresetChip>
        <PresetChip onClick={() => setHours(rangeArray(10, 18))}>근무(10-18)</PresetChip>
        <PresetChip onClick={() => setHours(rangeArray(18, 21))}>퇴근(18-21)</PresetChip>
      </div>

      <div className="hour-range">
        {/* Empty track (hairline) + selected span fill (ink) between the thumbs. */}
        <div className="hour-range__track" />
        <div
          className="hour-range__fill"
          style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }}
        />

        <input
          type="range"
          className="hour-range__input"
          min={MIN}
          max={MAX}
          step={1}
          value={start}
          aria-label="시작 시간"
          aria-valuetext={`${start}시`}
          onChange={(e) => onStart(e.target.value)}
          style={{ zIndex: startZ }}
        />
        <input
          type="range"
          className="hour-range__input"
          min={MIN}
          max={MAX}
          step={1}
          value={end}
          aria-label="종료 시간"
          aria-valuetext={`${end}시`}
          onChange={(e) => onEnd(e.target.value)}
          style={{ zIndex: endZ }}
        />
      </div>
    </FieldGroup>
  )
}

export default HourRange
