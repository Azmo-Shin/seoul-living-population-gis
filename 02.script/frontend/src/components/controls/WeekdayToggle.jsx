// WeekdayToggle — 전체/주중/주말 (PillTabs → setWeekday). Active = selection.weekday
// (ink inversion, no green). Maps 1:1 to the backend's weekday Literal.
//
// DISABLED in day mode: a single calendar date has a fixed weekday, so the 요일
// filter is meaningless (the day endpoint ignores it anyway). The pills are visually
// muted + non-interactive with a short hint — same UX-consistency fix as the 시간대
// filter being made live everywhere.
import FieldGroup from './FieldGroup.jsx'
import PillTab from '../ui/PillTab.jsx'
import useStore from '../../store/useStore.js'

const WEEKDAYS = ['전체', '주중', '주말']

// WeekdayToggle — `scope` selects which selection it reads/writes:
//   'A' (default) → selection.weekday + setWeekday (the normal A control).
//   'B'           → selectionB.weekday + setBWeekday (compare mode's B side).
// `mode` is SHARED between A and B, so the day-mode disable applies to both.
// When scope==='B' but compare is off (selectionB null) the control renders nothing.
function WeekdayToggle({ scope = 'A' }) {
  const isB = scope === 'B'
  const weekdayA = useStore((s) => s.selection.weekday)
  const weekdayB = useStore((s) => s.selectionB?.weekday)
  const setWeekdayA = useStore((s) => s.setWeekday)
  const setWeekdayB = useStore((s) => s.setBWeekday)
  const selectionB = useStore((s) => s.selectionB)
  const mode = useStore((s) => s.selection.mode)

  // Defensive: scope 'B' with compare off (selectionB null) → render nothing.
  if (isB && !selectionB) return null
  const weekday = isB ? weekdayB : weekdayA
  const setWeekday = isB ? setWeekdayB : setWeekdayA

  const disabled = mode === 'day'

  return (
    // 요일 — label + pills on ONE row (inline) to save a line. The day-mode hint, when
    // shown, wraps below the inline row (full width via the inline control column).
    <FieldGroup label="요일" inline>
      <div
        style={{
          display: 'flex',
          gap: 'var(--sp-xs)',
          flexWrap: 'wrap',
          // Muted + non-interactive when disabled (single date → fixed weekday).
          opacity: disabled ? 0.4 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
        role="group"
        aria-label="요일"
        aria-disabled={disabled || undefined}
      >
        {WEEKDAYS.map((w) => (
          <PillTab
            key={w}
            active={weekday === w}
            onClick={() => setWeekday(w)}
            disabled={disabled}
            tabIndex={disabled ? -1 : undefined}
          >
            {w}
          </PillTab>
        ))}
        {disabled && (
          <div
            className="t-caption-sm"
            style={{ color: 'var(--mute)', flexBasis: '100%' }}
          >
            일간 모드에서는 요일이 고정됩니다.
          </div>
        )}
      </div>
    </FieldGroup>
  )
}

export default WeekdayToggle
