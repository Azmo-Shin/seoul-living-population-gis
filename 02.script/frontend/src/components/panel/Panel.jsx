// Panel — the right-column composition (Task 7, finalized in Task 8). Stacks the
// KPI callout + ONE mode-appropriate chart. The column is scrollable since the
// charts stack (shell-kpi already has overflow:auto; the inner wrapper adds the
// gap + padding). Each child delegates loading/empty/error to the shared
// StateOverlay (Task 8), so every state stays consistent across the three cards.
//
// Mode-based composition (Task 8 §E):
//   month/week → KpiCallout (평균 생활인구) + CompareBar (spatial comparison).
//   day        → KpiCallout (평균 생활인구) + HourlyLine (EMPHASIZED time series).
// The KPI is a single 평균 생활인구 stat in every mode.
// In day mode the hourly line is the analytical focus: it gets a taller chart (320
// vs the bar's compact rows) so the time series clearly dominates the column.
//
// A-2 SPECIAL CASE (gu-scope grid view): when month/week AND the selection is the
// whole-gu grid (level==='grid' && dong===null && gu set), the primary analysis is
// the PER-동 grid 분위 distribution (GridDongAnalysis) — which 동's cells fall in
// which Spectral group — REPLACING the generic CompareBar there. Every other view
// (gu/dong choropleth, single-dong grid, multi-gu, day) is unchanged.
import useStore from '../../store/useStore.js'
import KpiCallout from './KpiCallout.jsx'
import CompareBar from './CompareBar.jsx'
import HourlyLine from './HourlyLine.jsx'
import GridDongAnalysis from './GridDongAnalysis.jsx'
import AllGuTrendCard from './AllGuTrendCard.jsx'

function Panel() {
  const mode = useStore((s) => s.selection.mode)
  const level = useStore((s) => s.selection.level)
  const gu = useStore((s) => s.selection.gu)
  const dong = useStore((s) => s.selection.dong)
  const isDay = mode === 'day'
  // A-2 gu-scope grid view: whole-gu grids (no specific dong drilled in). Only in
  // month/week (day mode's grid query returns no 행정동코드 → no per-동 distribution).
  const isGuScopeGrid = !isDay && level === 'grid' && dong === null && !!gu

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-lg)',
        padding: 'var(--sp-lg)',
      }}
    >
      <KpiCallout />
      {/* 전체 구 추이 — 상시 overview (우클릭 무관, 디폴트로 항상 표시). */}
      <AllGuTrendCard />
      {/* Day mode → emphasized hourly series (the day endpoint has no per-feature
          compare). A-2 gu-scope grid → per-동 분위 distribution. Else → spatial bars. */}
      {isDay ? (
        <HourlyLine />
      ) : isGuScopeGrid ? (
        <GridDongAnalysis />
      ) : (
        <CompareBar />
      )}
    </div>
  )
}

export default Panel
