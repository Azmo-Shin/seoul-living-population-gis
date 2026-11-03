// FilterRail — composes the Task 4 filter controls into the left rail, in the plan's
// order: 기간 → 지역 → 성별/연령 → 시간대 → 요일, followed by (when 비교 모드 is ON) a
// dedicated "B · 비교 대상" section holding B's OWN filters. Groups are separated by
// hairline dividers + COMPACT spacing so the core filters fit together without heavy
// scrolling on a typical desktop height. The rail is still scrollable (.shell-rail has
// overflow:auto) as a fallback. The 비교 모드 + 격자 toggles live in the BREADCRUMB ROW,
// not here; ModeTabs lives in the TopBar.
//
// COMPARE: 모드(일/주/월) + 지역(scope/격자) are SHARED between A and B — only the B
// section's 기간·성별·연령·시간대·요일 are independent. So the B section deliberately
// renders NO ModeTabs / ScopeSelect / GridToggle.
import PeriodPicker from './PeriodPicker.jsx'
import ScopeSelect from './ScopeSelect.jsx'
import SexAgeFilter from './SexAgeFilter.jsx'
import HourRange from './HourRange.jsx'
import WeekdayToggle from './WeekdayToggle.jsx'
import useStore from '../../store/useStore.js'

// Hairline divider between groups (no shadows — design rule). Tight vertical margin
// so dividers read as group separators without adding a full gap on each side.
const Divider = () => (
  <hr
    className="rail-divider"
    style={{
      border: 'none',
      borderTop: '1px solid var(--hairline)',
      margin: 0,
    }}
  />
)

function FilterRail() {
  const compareMode = useStore((s) => s.compareMode)
  const resetBToA = useStore((s) => s.resetBToA)

  return (
    <div className="filter-rail">
      {/* ── A (the normal rail filters) ──────────────────────────────────────── */}
      <PeriodPicker />
      <Divider />
      <ScopeSelect />
      <Divider />
      <SexAgeFilter />
      <Divider />
      <HourRange />
      <Divider />
      <WeekdayToggle />

      {/* ── B · 비교 대상 — only when compare mode is ON ─────────────────────────
          A clearly-labeled, visually distinct (left ink accent + boxed) section
          holding B's OWN filters. 모드/지역 are shared with A and intentionally
          omitted here. The 비교 모드 TOGGLE itself lives in the breadcrumb row. */}
      {compareMode && (
        <>
          <Divider />
          <div
            className="rail-compare-b"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--sp-xs)',
              padding: 'var(--sp-xs) var(--sp-sm)',
              // Gray tint (surface-soft) so the B section is clearly distinct from the
              // white A area above (user: white B background was confusing).
              background: 'var(--surface-soft)',
              border: '1px solid var(--hairline)',
              borderLeft: '2px solid var(--ink)',
              borderRadius: 'var(--r)',
            }}
          >
            {/* Section header — distinguishes A vs B at a glance. Small + dense so the
                A and B sets stack within the rail. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--sp-sm)',
              }}
            >
              <span className="t-caption" style={{ color: 'var(--ink)' }}>
                B · 비교 대상
              </span>
              {/* "A로 초기화" — resets B's filters to A's current filters. Green-free:
                  hairline border + ink text, no fill. */}
              <button
                type="button"
                className="t-caption-sm"
                onClick={resetBToA}
                style={{
                  padding: '2px 8px',
                  background: 'transparent',
                  color: 'var(--ink)',
                  border: '1px solid var(--hairline)',
                  borderRadius: 'var(--r)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font)',
                }}
              >
                A로 초기화
              </button>
            </div>

            <PeriodPicker scope="B" />
            <SexAgeFilter scope="B" />
            <HourRange scope="B" />
            <WeekdayToggle scope="B" />
          </div>
        </>
      )}
    </div>
  )
}

export default FilterRail
