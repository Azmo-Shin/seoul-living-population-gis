// HourlyLine — the 24-hour time-series for DAY mode only. Aggregates dayseries by
// 시간 (Σ over codes 값) → 24 points (0..23) and draws a single GREEN line+markers
// (the "강조 그린 1계열"). Axes/text/gridlines stay ink/mute/stone monochrome.
//
// A subtle LIGHT-GRAY (NOT green) band shades the SELECTED 시간대 [min..max] so the
// user sees which hours feed the KPI/map 평균. The band is omitted when all 24 hours
// are selected (full range = no emphasis needed).
//
// Renders nothing unless mode==='day' (panel composition guard). Within day mode,
// loading/empty/error are delegated to the shared StateOverlay (Task 8). Wrapped in
// a titled Card. In day mode this chart is the EMPHASIZED focus (taller).
import { useMemo } from 'react'
import useStore from '../../store/useStore.js'
import Card from '../ui/Card.jsx'
import StateOverlay from '../ui/StateOverlay.jsx'
import { derivePanelState } from './panelState.js'
import { baseLayout, baseConfig, GREEN, MUTE, HAIRLINE } from './plotly.js'
import ResponsivePlot from './ResponsivePlot.jsx'
import { hourlySeries, fullNumber } from './aggregate.js'

// Day-mode emphasis: the hourly line is the focus, so it gets a taller plot than
// the supporting CompareBar (whose default rows are ~22px each).
const CHART_HEIGHT = 320

function HourlyLine() {
  const mode = useStore((s) => s.selection.mode)
  const dayseries = useStore((s) => s.data.dayseries)
  const selHours = useStore((s) => s.selection.hours)
  // Narrow primitives for derivePanelState — NOT the whole `data` object — so this
  // Plotly-bearing card re-renders only when these slices change, not on every
  // unrelated `data` write.
  const loading = useStore((s) => s.data.loading)
  const error = useStore((s) => s.data.error)

  const isDay = mode === 'day'

  // Shared loading/empty/error precedence (error > loading > empty > ok).
  const overlay = derivePanelState({ loading, error, dayseries }, mode)

  const { hours, totals } = useMemo(
    () => (isDay ? hourlySeries(dayseries) : { hours: [], totals: [] }),
    [isDay, dayseries],
  )

  // Named `lineData` (not `data`) to keep Plotly's trace array distinct from store slices.
  const lineData = useMemo(
    () => [
      {
        type: 'scatter',
        mode: 'lines+markers',
        x: hours,
        y: totals,
        line: { color: GREEN, width: 2 },
        marker: { color: GREEN, size: 5 },
        text: totals.map((v) => fullNumber(v)),
        hovertemplate: '%{x}시<br>%{text}<extra></extra>',
      },
    ],
    [hours, totals],
  )

  // Shaded band over the SELECTED hours [min..max] (light gray, layer below the
  // line). Skipped when all 24 (or none → all) are selected — full range needs no
  // emphasis. Valid hours only (0..23); span half-units so it hugs the tick edges.
  const selectedShapes = useMemo(() => {
    const valid = (selHours ?? [])
      .map((h) => Number(h))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23)
    // Empty (= all) or full 24 → no band.
    if (valid.length === 0 || valid.length >= 24) return []
    const min = Math.min(...valid)
    const max = Math.max(...valid)
    return [
      {
        type: 'rect',
        xref: 'x',
        yref: 'paper', // full chart height regardless of y-range
        x0: min - 0.5,
        x1: max + 0.5,
        y0: 0,
        y1: 1,
        fillcolor: 'rgba(0,0,0,0.06)', // monochrome gray (NOT green)
        line: { width: 0 },
        layer: 'below',
      },
    ]
  }, [selHours])

  const layout = useMemo(
    () => ({
      ...baseLayout,
      height: CHART_HEIGHT,
      margin: { l: 56, r: 16, t: 8, b: 36 },
      shapes: selectedShapes,
      xaxis: {
        title: { text: '시간 (시)', font: { size: 11, color: MUTE } },
        showgrid: false,
        zeroline: false,
        linecolor: HAIRLINE,
        ticks: 'outside',
        tickfont: { size: 10, color: MUTE },
        tickmode: 'array',
        // Show every 3rd hour so the axis isn't crowded (0,3,…,21,23).
        tickvals: [0, 3, 6, 9, 12, 15, 18, 21, 23],
        ticktext: ['0', '3', '6', '9', '12', '15', '18', '21', '23'],
        range: [-0.5, 23.5],
        automargin: true,
      },
      yaxis: {
        showgrid: true,
        gridcolor: '#eee',
        zeroline: false,
        linecolor: HAIRLINE,
        tickfont: { size: 10, color: MUTE },
        automargin: true,
        rangemode: 'tozero',
      },
    }),
    [selectedShapes],
  )

  // Panel-composition guard: only render in day mode.
  if (!isDay) return null

  return (
    <Card title="시간대별 (일간)">
      {overlay ? (
        // Shared loading/empty/error markup (one source of truth, Task 8). Reserve
        // the chart's height so the emphasized card doesn't visibly collapse.
        <StateOverlay state={overlay} message={error} minHeight={CHART_HEIGHT} />
      ) : (
        <div style={{ paddingTop: 'var(--sp-xs)' }}>
          <ResponsivePlot
            data={lineData}
            layout={layout}
            config={baseConfig}
            style={{ width: '100%', height: `${CHART_HEIGHT}px` }}
            useResizeHandler
          />
        </div>
      )}
    </Card>
  )
}

export default HourlyLine
