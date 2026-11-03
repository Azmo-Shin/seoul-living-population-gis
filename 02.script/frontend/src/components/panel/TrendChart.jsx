// TrendChart — presentational, mode-aware trend chart BODY (no store / card / close).
// The inspect panel feeds it a grid's trend slice as PROPS. Renders:
//   month/week → one 평균 생활인구 line (x = 연월 / 주 날짜기간).
//   day        → TWO mini lines: 동일 요일(요일) 추이 + 최근 30일 추이.
// All averages come from the caller's 시간수 (= hourCount(selection.hours)):
//   month/week 평균 = 합계 / (일수 × 시간수)  via trendAverages
//   day        평균 = 합계 / 시간수 (일수=1)    via dayTrendAverages
// Pure props → reusable (the floating card was retired; this now lives in the panel).
import { useMemo } from 'react'
import { baseLayout, baseConfig, GREEN, MUTE, HAIRLINE } from './plotly.js'
import ResponsivePlot from './ResponsivePlot.jsx'
import { trendAverages, dayTrendAverages, fullNumber } from './aggregate.js'
import { isoWeekRange, isoWeekRangeLabel } from '../../lib/isoWeek.js'
import StateOverlay from '../ui/StateOverlay.jsx'

const CHART_HEIGHT = 168
const DAY_CHART_HEIGHT = 116
const KO_DOW = ['일', '월', '화', '수', '목', '금', '토']

// "202401" → "24.01" (compact x tick). Non-6-char 라벨 falls through unchanged.
function fmtYYMM(라벨) {
  const p = String(라벨 ?? '')
  return p.length === 6 ? `${p.slice(2, 4)}.${p.slice(4, 6)}` : p
}
// "202401" → "2024.01" (hover, fuller).
function fmtYearMonth(라벨) {
  const p = String(라벨 ?? '')
  return p.length === 6 ? `${p.slice(0, 4)}.${p.slice(4, 6)}` : p
}
// "2026-05-06" → "05.06" (compact day tick).
function fmtMMDD(일자) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(일자 ?? ''))
  return m ? `${m[1]}.${m[2]}` : String(일자 ?? '')
}
// "2026-12" (연주 "YYYY-WW") → {year, week} | null.
function parseYearWeek(라벨) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(라벨 ?? ''))
  return m ? { year: Number(m[1]), week: Number(m[2]) } : null
}
// week 라벨 → the week's Monday as "MM.DD" (x tick).
function fmtWeekStart(라벨) {
  const yw = parseYearWeek(라벨)
  if (!yw) return String(라벨 ?? '')
  return fmtMMDD(isoWeekRange(yw.year, yw.week).start)
}
// week 라벨 → "06.02 – 06.08" full Mon–Sun range (hover).
function fmtWeekRange(라벨) {
  const yw = parseYearWeek(라벨)
  return yw ? isoWeekRangeLabel(yw.year, yw.week) : String(라벨 ?? '')
}
// "2026-06-05" → '금' (Korean weekday). '' if unparseable.
function koWeekday(일자) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(일자 ?? ''))
  if (!m) return ''
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return KO_DOW[d.getUTCDay()] ?? ''
}

// Single-line Plotly trace. `rows` carry {[keyName], 평균}; null 평균 → gap.
function lineTrace(rows, keyName, xfmt, hoverfmt) {
  return [
    {
      type: 'scatter',
      mode: 'lines',
      x: rows.map((r) => xfmt(r[keyName])),
      y: rows.map((r) => (r.평균 === null ? null : r.평균)),
      line: { color: GREEN, width: 2 },
      connectgaps: false,
      text: rows.map((r) =>
        r.평균 === null ? '—' : `${hoverfmt(r[keyName])} · ${fullNumber(r.평균)}`,
      ),
      hovertemplate: '%{text}<extra></extra>',
    },
  ]
}

function lineLayout(height, nticks) {
  return {
    ...baseLayout,
    height,
    margin: { l: 48, r: 10, t: 6, b: 28 },
    xaxis: {
      showgrid: false,
      zeroline: false,
      linecolor: HAIRLINE,
      ticks: 'outside',
      tickfont: { size: 9, color: MUTE },
      type: 'category',
      tickmode: 'auto',
      nticks,
      automargin: true,
    },
    yaxis: {
      showgrid: true,
      gridcolor: '#eee',
      zeroline: false,
      linecolor: HAIRLINE,
      tickfont: { size: 9, color: MUTE },
      automargin: true,
      rangemode: 'tozero',
    },
  }
}

const anyFinite = (rows) => rows.some((r) => r.평균 !== null && Number.isFinite(r.평균))

/**
 * @param {{ mode:'month'|'week'|'day', points?:Array, recent30?:Array,
 *           sameWeekday?:Array, 시간수:number }} props
 */
function TrendChart({ mode = 'month', points = [], recent30 = [], sameWeekday = [], 시간수 }) {
  const isWeek = mode === 'week'
  const isDay = mode === 'day'

  const mwRows = useMemo(() => trendAverages(points, 시간수), [points, 시간수])
  const recent30Rows = useMemo(() => dayTrendAverages(recent30, 시간수), [recent30, 시간수])
  const sameWeekdayRows = useMemo(
    () => dayTrendAverages(sameWeekday, 시간수),
    [sameWeekday, 시간수],
  )

  const mwChart = useMemo(
    () => ({
      data: lineTrace(
        mwRows,
        '라벨',
        isWeek ? fmtWeekStart : fmtYYMM,
        isWeek ? fmtWeekRange : fmtYearMonth,
      ),
      layout: lineLayout(CHART_HEIGHT, 8),
    }),
    [mwRows, isWeek],
  )
  const recent30Chart = useMemo(
    () => ({ data: lineTrace(recent30Rows, '일자', fmtMMDD, fmtMMDD), layout: lineLayout(DAY_CHART_HEIGHT, 6) }),
    [recent30Rows],
  )
  const sameWeekdayChart = useMemo(
    () => ({ data: lineTrace(sameWeekdayRows, '일자', fmtMMDD, fmtMMDD), layout: lineLayout(DAY_CHART_HEIGHT, 6) }),
    [sameWeekdayRows],
  )

  const hasData = isDay
    ? anyFinite(recent30Rows) || anyFinite(sameWeekdayRows)
    : anyFinite(mwRows)
  if (!hasData) return <StateOverlay state="empty" minHeight={CHART_HEIGHT} />

  if (!isDay) {
    return (
      <ResponsivePlot
        data={mwChart.data}
        layout={mwChart.layout}
        config={baseConfig}
        style={{ width: '100%', height: `${CHART_HEIGHT}px` }}
        useResizeHandler
      />
    )
  }

  const sameDow = koWeekday(sameWeekday?.[0]?.일자)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-sm)' }}>
      <DaySubChart
        caption={`동일 요일${sameDow ? `(${sameDow})` : ''} 추이`}
        chart={sameWeekdayChart}
        hasData={anyFinite(sameWeekdayRows)}
      />
      <DaySubChart
        caption="최근 30일 추이"
        chart={recent30Chart}
        hasData={anyFinite(recent30Rows)}
      />
    </div>
  )
}

function DaySubChart({ caption, chart, hasData }) {
  return (
    <div>
      <div className="t-caption-sm" style={{ color: 'var(--mute)', marginBottom: 2 }}>
        {caption}
      </div>
      {hasData ? (
        <ResponsivePlot
          data={chart.data}
          layout={chart.layout}
          config={baseConfig}
          style={{ width: '100%', height: `${DAY_CHART_HEIGHT}px` }}
          useResizeHandler
        />
      ) : (
        <StateOverlay state="empty" minHeight={DAY_CHART_HEIGHT} />
      )}
    </div>
  )
}

export default TrendChart
