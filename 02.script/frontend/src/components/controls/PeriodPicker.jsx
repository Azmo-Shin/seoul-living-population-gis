// PeriodPicker — period control whose SHAPE depends on selection.mode, bounded by
// data.range. month → <input type="month">; week → year + week-number Selects;
// day → <input type="date">. Every change funnels through setPeriod (debounced
// fetch). The period is stored in the BACKEND form per mode:
//   month 'YYYYMM' (no dash) | week 'YYYY-WW' (zero-padded) | day 'YYYY-MM-DD'.
// When data.range is null (not loaded), render a disabled placeholder.
import FieldGroup from './FieldGroup.jsx'
import Select from '../ui/Select.jsx'
import useStore from '../../store/useStore.js'
import { isoWeekRangeLabel } from '../../lib/isoWeek.js'

// Native date/month inputs styled to match Select (token-based, hairline). DENSE:
// 30px min-height for the compact rail (the .filter-rail CSS also enforces this), a
// touch below 44px — acceptable for this dense DESKTOP filter panel per the explicit
// compactness request.
const NATIVE_INPUT = {
  width: '100%',
  minHeight: '30px',
  padding: '0 10px',
  background: 'var(--canvas)',
  color: 'var(--ink)',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--r)',
  fontFamily: 'var(--font)',
}

// Static style for the equal-width week/year Select wrappers (hoisted out of render).
const FLEX_FILL = { flex: '1 1 0' }

const zero2 = (n) => String(n).padStart(2, '0')

// 'YYYY-WW' → {year:number, week:number}
function parseWeek(s) {
  const [y, w] = String(s).split('-')
  return { year: Number(y), week: Number(w) }
}

function MonthInput({ range, period, setPeriod }) {
  // period 'YYYYMM' → input value 'YYYY-MM' (insert dash). Empty/short → ''.
  const value =
    period && period.length === 6 ? `${period.slice(0, 4)}-${period.slice(4)}` : ''
  return (
    <input
      type="month"
      className="t-body"
      aria-label="월 선택"
      value={value}
      min={range.month.min}
      max={range.month.max}
      onChange={(e) => {
        const v = e.target.value // 'YYYY-MM' (or '' if cleared)
        if (v) setPeriod(v.replace('-', '')) // → 'YYYYMM'
      }}
      style={NATIVE_INPUT}
    />
  )
}

function DayInput({ range, period, setPeriod }) {
  return (
    <input
      type="date"
      className="t-body"
      aria-label="날짜 선택"
      value={period || ''}
      min={range.day.min}
      max={range.day.max}
      onChange={(e) => {
        if (e.target.value) setPeriod(e.target.value) // already 'YYYY-MM-DD'
      }}
      style={NATIVE_INPUT}
    />
  )
}

function WeekPicker({ range, period, setPeriod }) {
  const { year: minY, week: minW } = parseWeek(range.week.min)
  const { year: maxY, week: maxW } = parseWeek(range.week.max)
  const cur = parseWeek(period && period.includes('-') ? period : range.week.max)

  // Year options across the available span.
  const years = []
  for (let y = minY; y <= maxY; y++) years.push({ value: String(y), label: `${y}년` })

  // Week-number options for the selected year: clamp to available range at the
  // boundary years (min year starts at minW; max year ends at maxW), else 1..52.
  // The VALUE stays the week NUMBER (the backend period is still "YYYY-WW"); only the
  // LABEL shows the ISO week's actual Mon–Sun date range ("06.02 – 06.08") so the user
  // knows WHEN the week is, not just its ordinal. Range computed client-side via
  // isoWeekRange (ISO-8601: weeks start Monday, week 1 holds the year's first Thursday).
  const wLo = cur.year === minY ? minW : 1
  const wHi = cur.year === maxY ? maxW : 52
  const weeks = []
  for (let w = wLo; w <= wHi; w++)
    weeks.push({ value: String(w), label: isoWeekRangeLabel(cur.year, w) })

  const emit = (year, week) => setPeriod(`${year}-${zero2(week)}`)

  return (
    <div style={{ display: 'flex', gap: 'var(--sp-sm)' }}>
      <div style={FLEX_FILL}>
        <Select
          aria-label="연도 선택"
          value={String(cur.year)}
          options={years}
          onChange={(v) => {
            const y = Number(v)
            // Re-clamp the week into the new year's valid span.
            const lo = y === minY ? minW : 1
            const hi = y === maxY ? maxW : 52
            const w = Math.min(Math.max(cur.week, lo), hi)
            emit(y, w)
          }}
        />
      </div>
      <div style={FLEX_FILL}>
        <Select
          aria-label="주 선택"
          value={String(Math.min(Math.max(cur.week, wLo), wHi))}
          options={weeks}
          onChange={(v) => emit(cur.year, Number(v))}
        />
      </div>
    </div>
  )
}

// PeriodPicker — `scope` selects which selection it reads/writes:
//   'A' (default) → selection.period + setPeriod (the normal A control).
//   'B'           → selectionB.period + setBPeriod (compare mode's B period).
// The picker SHAPE always follows A's `mode` (mode is SHARED between A and B in
// STAGE 1, so there is no separate B mode). When scope==='B' but compare is off
// (selectionB null) the control renders disabled defensively.
function PeriodPicker({ scope = 'A' }) {
  const mode = useStore((s) => s.selection.mode)
  const periodA = useStore((s) => s.selection.period)
  const periodB = useStore((s) => s.selectionB?.period)
  const range = useStore((s) => s.data.range)
  const setPeriodA = useStore((s) => s.setPeriod)
  const setPeriodB = useStore((s) => s.setBPeriod)
  const isB = scope === 'B'
  const period = isB ? periodB : periodA
  const setPeriod = isB ? setPeriodB : setPeriodA
  const label = isB ? 'B · 비교 기간' : '기간'

  let body
  if (!range || (isB && period == null)) {
    // range not loaded yet (or B not ready) — disabled placeholder.
    body = (
      <Select
        aria-label={label}
        value=""
        options={[]}
        placeholder="기간 로딩 중…"
        disabled
      />
    )
  } else if (mode === 'month') {
    body = <MonthInput range={range} period={period} setPeriod={setPeriod} />
  } else if (mode === 'week') {
    body = <WeekPicker range={range} period={period} setPeriod={setPeriod} />
  } else {
    body = <DayInput range={range} period={period} setPeriod={setPeriod} />
  }

  return <FieldGroup label={label}>{body}</FieldGroup>
}

export default PeriodPicker
