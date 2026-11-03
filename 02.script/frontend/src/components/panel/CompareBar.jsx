// CompareBar — a horizontal Plotly bar chart comparing the CURRENT level's
// features (현재 level 상위 비교). Each bar is colored by its value using the SAME
// Spectral (blue→red) colorScale as the map choropleth, so a bar's color matches
// that area's map color; chrome stays ink/mute/stone monochrome (see plotly.js).
//
// Data: compareBarData() reshapes valuesByCode → [{name, value, code}] sorted DESC
// by 평균 생활인구 (the headline metric, matching the map). For gu (25) / dongs (~20)
// it shows all; for grids (hundreds) it shows the TOP N and annotates "상위 N".
//
// Horizontal bars (names on y) keep Korean labels legible. Loading/empty/error are
// delegated to the shared StateOverlay (Task 8). Wrapped in a titled Card.
import { useMemo } from 'react'
import useStore from '../../store/useStore.js'
import Card from '../ui/Card.jsx'
import StateOverlay from '../ui/StateOverlay.jsx'
import { derivePanelState } from './panelState.js'
import { baseLayout, baseConfig, MUTE, HAIRLINE } from './plotly.js'
import ResponsivePlot from './ResponsivePlot.jsx'
import { compareBarData, fullNumber } from './aggregate.js'
import { buildColorScale } from '../../lib/colorScale.js'

// Top-N PER LEVEL. gu (25) / dong (~20) are small enough to show ALL; grids can be
// hundreds, so they truncate to a readable top slice (and annotate "상위 N").
const TOP_N_BY_LEVEL = { gu: Infinity, dong: Infinity, grid: 15 }

// Per-level title + metric label. The metric is 평균 생활인구.
const LEVEL_LABEL = { gu: '구', dong: '행정동', grid: '격자' }

// [r,g,b] → Plotly CSS color.
const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`

function CompareBar() {
  const level = useStore((s) => s.selection.level)
  const mode = useStore((s) => s.selection.mode)
  const valuesByCode = useStore((s) => s.data.valuesByCode)
  const districts = useStore((s) => s.data.districts)
  const dongs = useStore((s) => s.data.dongs)
  // The per-code metric map the choropleth colors by — build the SAME Spectral
  // scale here so each bar matches its area's map color.
  const values = useStore((s) => s.data.values)
  // Narrow primitives for derivePanelState — NOT the whole `data` object — so this
  // Plotly-bearing card re-renders only when these slices change, not on every
  // unrelated `data` write (dongsGeo/districts/loading toggles, etc.).
  const loading = useStore((s) => s.data.loading)
  const error = useStore((s) => s.data.error)

  // Shared loading/empty/error precedence (error > loading > empty > ok).
  // Built from narrow slices (non-day → dayseries unused; pass [] to satisfy the
  // helper's shape without subscribing to it).
  const overlay = derivePanelState(
    { loading, error, valuesByCode, dayseries: [] },
    mode,
  )

  // In day mode there is no valuesByCode (the day endpoint returns a raw series),
  // so this chart is for month/week. The panel composition only shows it then, but
  // we guard internally too so a stale day-mode render is a clean placeholder.
  const isMonthWeek = mode !== 'day'

  const topN = TOP_N_BY_LEVEL[level] ?? 15

  const { rows, total, truncated } = useMemo(
    () =>
      isMonthWeek
        ? compareBarData(valuesByCode, level, {
            districts,
            dongs,
            topN,
          })
        : { rows: [], total: 0, truncated: false },
    [isMonthWeek, valuesByCode, level, districts, dongs, topN],
  )

  const metricLabel = '평균 생활인구'
  // Only show the "상위 N" suffix for a FINITE cap that actually truncated — so it
  // can never render "상위 Infinity" (gu/dong topN is Infinity) if a cap is lowered.
  const showTopN = Number.isFinite(topN) && truncated
  const title = `${LEVEL_LABEL[level] ?? ''}별 비교${
    showTopN ? ` (상위 ${topN})` : ''
  }`

  // Plotly draws horizontal bars bottom→top, so reverse the DESC rows: the LARGEST
  // value lands at the TOP of the chart.
  const ordered = useMemo(() => [...rows].reverse(), [rows])

  // Same Spectral quantile scale the map uses (built from the full `values` set), so
  // a bar's color === that area's choropleth color (top/largest bars red, low blue).
  const scale = useMemo(() => buildColorScale(values), [values])

  // Named `barData` (not `data`) to keep Plotly's trace array distinct from store slices.
  const barData = useMemo(
    () => [
      {
        type: 'bar',
        orientation: 'h',
        x: ordered.map((r) => r.value),
        y: ordered.map((r) => r.name),
        // Per-bar Spectral color = the area's map color (high=red, low=blue).
        marker: { color: ordered.map((r) => rgbCss(scale.getColor(r.value))) },
        // Flat ko-KR hover: name + full value (no abbreviation in the tooltip).
        text: ordered.map((r) => fullNumber(r.value)),
        hovertemplate: '%{y}<br>%{text}<extra></extra>',
      },
    ],
    [ordered, scale],
  )

  // Height scales with row count so labels never crush together; capped so the
  // panel stays scrollable rather than one chart eating the column. SINGLE source
  // of truth: this drives Plotly `layout.height`; the container only mirrors width
  // (height is left to the Plot so the two can't briefly disagree on resize).
  const height = Math.min(Math.max(ordered.length * 22 + 60, 160), 620)

  const layout = useMemo(
    () => ({
      ...baseLayout,
      height,
      margin: { l: 96, r: 24, t: 8, b: 36 },
      xaxis: {
        title: { text: metricLabel, font: { size: 11, color: MUTE } },
        showgrid: false,
        zeroline: true,
        zerolinecolor: HAIRLINE,
        linecolor: HAIRLINE,
        ticks: 'outside',
        tickfont: { size: 10, color: MUTE },
        automargin: true,
      },
      yaxis: {
        showgrid: false,
        zeroline: false,
        linecolor: HAIRLINE,
        tickfont: { size: 11 },
        automargin: true,
      },
    }),
    [height],
  )

  return (
    <Card title={title}>
      {overlay ? (
        // Shared loading/empty/error markup (one source of truth, Task 8).
        <StateOverlay state={overlay} message={error} minHeight={120} />
      ) : !isMonthWeek ? (
        // Defensive: panel composition never shows this in day mode, but guard a
        // stale day-mode render so we never feed Plotly an empty/NaN series.
        <div
          className="t-body-sm"
          style={{ color: 'var(--mute)', paddingTop: 'var(--sp-xs)' }}
        >
          일간 모드에서는 비교가 표시되지 않습니다.
        </div>
      ) : (
        <div style={{ paddingTop: 'var(--sp-xs)' }}>
          <ResponsivePlot
            data={barData}
            layout={layout}
            config={baseConfig}
            style={{ width: '100%' }}
            useResizeHandler
          />
          {truncated && (
            <div
              className="t-caption-sm"
              style={{ color: 'var(--mute)', marginTop: 'var(--sp-xxs)' }}
            >
              총 {total.toLocaleString('ko-KR')}개 중 상위 {topN}개
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

export default CompareBar
