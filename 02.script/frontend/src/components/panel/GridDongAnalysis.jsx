// GridDongAnalysis — the A-2 (gu-scope grid) panel analysis. For the whole-gu grid
// view (selection.level==='grid' && dong===null && gu set), it shows — PER 행정동 —
// how the gu's 250m grid cells distribute across the colorScale's 6 Spectral 분위
// groups. A STACKED HORIZONTAL bar per 동 (y=행정동명, stacked segments = the bins),
// so the user reads each 동's intensity composition at a glance.
//
// Bin colors here are the SAME Spectral data colors as the map fill + Legend (built
// from the SAME `data.values` via buildColorScale) — that color IS the data encoding
// and is correct/intended. All other chrome (axes/text/grid) stays ink/mute/hairline.
//
// A small ink-chip toggle (개수 ⇄ 비율) switches between raw grid COUNT and a
// 100%-stacked PERCENTAGE view (binCountsToPct). Loading/empty/error delegate to the
// shared StateOverlay; wrapped in a titled Card. This component renders ONLY in the
// A-2 gu-scope grid view (Panel.jsx owns that gating).
import { useMemo, useState } from 'react'
import useStore from '../../store/useStore.js'
import Card from '../ui/Card.jsx'
import StateOverlay from '../ui/StateOverlay.jsx'
import PillTab from '../ui/PillTab.jsx'
import { derivePanelState } from './panelState.js'
import { baseLayout, baseConfig, MUTE, HAIRLINE } from './plotly.js'
import ResponsivePlot from './ResponsivePlot.jsx'
import { gridDongBinCounts, binCountsToPct, buildNameLookup } from './aggregate.js'
import { buildColorScale } from '../../lib/colorScale.js'

// [r,g,b] → Plotly CSS color.
const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`

// Per-bin label by INDEX (ascending value → bin 0 = lowest 분위, last = highest),
// matching the map/legend's low→high (blue→red) order. Used for the trace name +
// hover only. Terse so the compact panel hover stays readable.
function binLabel(i, n) {
  if (i === 0) return `${i + 1}분위 (최저)`
  if (i === n - 1) return `${i + 1}분위 (최고)`
  return `${i + 1}분위`
}

function GridDongAnalysis() {
  const values = useStore((s) => s.data.values)
  const gridDong = useStore((s) => s.data.gridDong)
  const gridBreakdown = useStore((s) => s.data.gridBreakdown) // 경계셀 동별 portion (분할용)
  const dongs = useStore((s) => s.data.dongs)
  // Narrow primitives for derivePanelState — NOT the whole `data` object — so this
  // Plotly-bearing card re-renders only on the slices it uses.
  const loading = useStore((s) => s.data.loading)
  const error = useStore((s) => s.data.error)
  const valuesByCode = useStore((s) => s.data.valuesByCode)

  // 개수(count) ⇄ 비율(%) — local view toggle. Default 개수 (raw cell counts).
  const [asPct, setAsPct] = useState(false)

  // month/week precedence (this view is never shown in day mode — gridDong is only
  // populated by the postQuery path). Pass [] for dayseries to satisfy the shape.
  const overlay = derivePanelState(
    { loading, error, valuesByCode, dayseries: [] },
    'month',
  )

  // The SAME Spectral quantile scale the map/Legend uses (built from the full grid
  // `values`), so a stacked segment's color === that 분위's map color.
  const scale = useMemo(() => buildColorScale(values), [values])

  // 행정동코드 → 행정동명 lookup for the bar labels (from the gu's dongs meta).
  const dongNames = useMemo(() => buildNameLookup('dong', [], dongs), [dongs])

  // Pass gridBreakdown so a 격자 straddling 2+ 동 is SPLIT — each 동 counts its own
  // portion (binned by that portion's 평균) instead of the whole cell landing on one
  // MAX 동. With no breakdown loaded (day mode) it falls back to whole-cell counting.
  const { rows, nBins } = useMemo(
    () => gridDongBinCounts(values, gridDong, scale, dongNames, gridBreakdown),
    [values, gridDong, scale, dongNames, gridBreakdown],
  )

  // Plotly draws horizontal bars bottom→top; reverse so the FIRST row (densest 동,
  // gridDongBinCounts sorts DESC by total) lands at the TOP of the chart.
  const ordered = useMemo(() => [...rows].reverse(), [rows])

  // ONE stacked trace per bin index (ascending value). Each trace's x = that bin's
  // count (or %) across the ordered 동; y = 행정동명. marker.color = the bin's
  // Spectral data color (matches the map). Hover shows 동 + 분위 + value.
  const barData = useMemo(() => {
    const yNames = ordered.map((r) => r.행정동명)
    const pctByRow = ordered.map((r) => binCountsToPct(r))
    const traces = []
    for (let bi = 0; bi < nBins; bi++) {
      const color = scale.bins?.[bi]?.color
      const x = ordered.map((r, ri) =>
        asPct ? pctByRow[ri][bi] ?? 0 : r.counts[bi] ?? 0,
      )
      // Custom hover text per cell: count + % so both readings are always available.
      const customdata = ordered.map((r, ri) => {
        const c = r.counts[bi] ?? 0
        const p = pctByRow[ri][bi] ?? 0
        return [c, p.toFixed(1)]
      })
      traces.push({
        type: 'bar',
        orientation: 'h',
        name: binLabel(bi, nBins),
        x,
        y: yNames,
        marker: {
          color: color ? rgbCss(color) : 'rgba(0,0,0,0.12)',
          line: { color: HAIRLINE, width: 0.5 },
        },
        customdata,
        hovertemplate:
          `%{y}<br>${binLabel(bi, nBins)}` +
          '<br>%{customdata[0]}개 (%{customdata[1]}%)<extra></extra>',
      })
    }
    return traces
  }, [ordered, nBins, scale, asPct])

  // Height scales with 동 count so labels never crush; capped so the panel stays
  // scrollable. Mirrors CompareBar's sizing rule (rows × ~26px + chrome).
  const height = Math.min(Math.max(ordered.length * 26 + 64, 160), 620)

  const xTitle = asPct ? '격자 비율 (%)' : '격자 수 (개)'

  const layout = useMemo(
    () => ({
      ...baseLayout,
      height,
      barmode: 'stack',
      margin: { l: 104, r: 16, t: 8, b: 36 },
      // Stacked segments carry their own data colors → suppress Plotly's colorway.
      xaxis: {
        title: { text: xTitle, font: { size: 11, color: MUTE } },
        showgrid: false,
        zeroline: true,
        zerolinecolor: HAIRLINE,
        linecolor: HAIRLINE,
        ticks: 'outside',
        tickfont: { size: 10, color: MUTE },
        automargin: true,
        // In % mode lock the axis to 0..100 so the 100%-stacked bars fill fully.
        ...(asPct ? { range: [0, 100] } : {}),
      },
      yaxis: {
        showgrid: false,
        zeroline: false,
        linecolor: HAIRLINE,
        tickfont: { size: 11 },
        automargin: true,
      },
    }),
    [height, asPct, xTitle],
  )

  return (
    <Card title="동별 격자 분포 (분위 그룹)">
      {/* 개수 ⇄ 비율 ink-chip toggle. Ink inversion = active (never green). */}
      <div
        role="group"
        aria-label="표시 단위"
        style={{
          display: 'flex',
          gap: 'var(--sp-xxs)',
          marginBottom: 'var(--sp-xs)',
        }}
      >
        <PillTab active={!asPct} onClick={() => setAsPct(false)}>
          개수
        </PillTab>
        <PillTab active={asPct} onClick={() => setAsPct(true)}>
          비율
        </PillTab>
      </div>

      {overlay ? (
        <StateOverlay state={overlay} message={error} minHeight={120} />
      ) : ordered.length === 0 ? (
        // Values present but no grid→동 membership (e.g. day mode, or backend
        // omitted 행정동코드) — a clean empty rather than an axis-less Plotly.
        <StateOverlay state="empty" minHeight={120} />
      ) : (
        <div style={{ paddingTop: 'var(--sp-xs)' }}>
          <ResponsivePlot
            data={barData}
            layout={layout}
            config={baseConfig}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <div
            className="t-caption-sm"
            style={{ color: 'var(--mute)', marginTop: 'var(--sp-xxs)' }}
          >
            색상 = 분위 그룹 (지도·범례와 동일) · 낮음(파랑) → 높음(빨강) · 경계 격자는 동별 portion 분할
          </div>
        </div>
      )}
    </Card>
  )
}

export default GridDongAnalysis
