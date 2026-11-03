// AllGuTrendCard — the 전체 구 추이 overview, shown by DEFAULT in the right panel. 25 구
// 라인, 현재 모드/필터 반영. data.allGuTrend is fetched on init + every filter/mode change.
//
// READABILITY (25 lines in a narrow panel): (1) a TALLER chart, (2) HOVER-SPOTLIGHT —
// hovering a 구's line bolds it + dims the rest (imperative Plotly.restyle on hover, reset
// on unhover) so a single 구 reads clearly without a 25-item legend, (3) hover tooltip
// names the 구. Lines use distinct hues; chrome stays green-free.
import { useMemo, useRef, useCallback } from 'react'
import Plotly from 'plotly.js-dist'
import useStore from '../../store/useStore.js'
import Card from '../ui/Card.jsx'
import StateOverlay from '../ui/StateOverlay.jsx'
import ResponsivePlot from './ResponsivePlot.jsx'
import { baseLayout, baseConfig, MUTE, HAIRLINE } from './plotly.js'
import { isoWeekRange } from '../../lib/isoWeek.js'

const MODE_TITLE = { month: '월별', week: '주별', day: '일별' }
const CHART_H = 360
const BASE_W = 1.4 // default line width
const guHue = (i, n) => `hsl(${Math.round((i * 360) / Math.max(n, 1))}, 62%, 48%)`
const fmtYYMM = (l) => {
  const p = String(l ?? '')
  return p.length === 6 ? `${p.slice(2, 4)}.${p.slice(4, 6)}` : p
}
const fmtMMDD = (l) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(l ?? ''))
  return m ? `${m[1]}.${m[2]}` : String(l ?? '')
}
const fmtWeek = (l) => {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(l ?? ''))
  return m ? fmtMMDD(isoWeekRange(Number(m[1]), Number(m[2])).start) : String(l ?? '')
}

function AllGuTrendCard() {
  const allGu = useStore((s) => s.data.allGuTrend)
  const gdRef = useRef(null) // the Plotly graphDiv (for hover restyle)

  const lines = useMemo(() => {
    const byGu = allGu.byGu ?? {}
    const names = allGu.names ?? {}
    const xfmt = allGu.mode === 'week' ? fmtWeek : allGu.mode === 'day' ? fmtMMDD : fmtYYMM
    const codes = Object.keys(byGu).sort()
    return codes.map((gu, i) => {
      const series = byGu[gu]
      const nm = names[gu] ?? gu
      return {
        type: 'scatter',
        mode: 'lines',
        name: nm,
        x: series.map((p) => xfmt(p.라벨)),
        y: series.map((p) => (p.평균 === null ? null : p.평균)),
        line: { color: guHue(i, codes.length), width: BASE_W },
        opacity: 1,
        connectgaps: false,
        hovertemplate: `<b>${nm}</b><br>%{x} · %{y:,.0f}명<extra></extra>`,
      }
    })
  }, [allGu])

  const n = lines.length
  const captureGd = useCallback((fig, gd) => {
    gdRef.current = gd
  }, [])
  // hover → spotlight the hovered 구; dim the rest. unhover → reset all.
  const onHover = useCallback(
    (e) => {
      const ci = e?.points?.[0]?.curveNumber
      const gd = gdRef.current
      if (ci == null || !gd) return
      const w = new Array(n)
      const o = new Array(n)
      for (let i = 0; i < n; i++) {
        w[i] = i === ci ? 3.2 : 0.8
        o[i] = i === ci ? 1 : 0.15
      }
      Plotly.restyle(gd, { 'line.width': w, opacity: o })
    },
    [n],
  )
  const onUnhover = useCallback(() => {
    const gd = gdRef.current
    if (!gd) return
    Plotly.restyle(gd, { 'line.width': new Array(n).fill(BASE_W), opacity: new Array(n).fill(1) })
  }, [n])

  const hasData = lines.some((t) => t.y.some((v) => Number.isFinite(v)))

  return (
    <Card title={`전체 구 ${MODE_TITLE[allGu.mode] ?? ''} 추이`}>
      {allGu.error ? (
        <StateOverlay state="error" message={allGu.error} minHeight={120} />
      ) : allGu.loading && !hasData ? (
        <StateOverlay state="loading" minHeight={120} />
      ) : !hasData ? (
        <StateOverlay state="empty" minHeight={120} />
      ) : (
        <div style={{ paddingTop: 'var(--sp-xs)' }}>
          <ResponsivePlot
            data={lines}
            layout={{
              ...baseLayout,
              height: CHART_H,
              margin: { l: 48, r: 10, t: 6, b: 30 },
              showlegend: false,
              hovermode: 'closest',
              xaxis: { showgrid: false, zeroline: false, linecolor: HAIRLINE, ticks: 'outside', tickfont: { size: 10, color: MUTE }, type: 'category', tickmode: 'auto', nticks: 8, automargin: true },
              yaxis: { showgrid: true, gridcolor: '#eee', zeroline: false, linecolor: HAIRLINE, tickfont: { size: 10, color: MUTE }, automargin: true, rangemode: 'tozero' },
            }}
            config={baseConfig}
            onInitialized={captureGd}
            onUpdate={captureGd}
            onHover={onHover}
            onUnhover={onUnhover}
            style={{ width: '100%', height: `${CHART_H}px` }}
            useResizeHandler
          />
          <div className="t-caption-sm" style={{ color: 'var(--mute)', marginTop: 'var(--sp-xxs)' }}>
            25개 구 · 선 위에 마우스를 올리면 그 구만 강조됩니다
          </div>
        </div>
      )}
    </Card>
  )
}

export default AllGuTrendCard
