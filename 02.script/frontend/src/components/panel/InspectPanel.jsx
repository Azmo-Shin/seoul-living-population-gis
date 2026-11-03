// InspectPanel — the 우클릭 분석 POPUP (floating card over the map). Shows the
// distribution ONE LEVEL BELOW the right-clicked area:
//   gu   → 행정동별 비교(막대)
//   dong → 그 동의 격자 평균 분위 분포(파이) — binned against the **구 전체** grid scale
//          (동 자체 분위는 정의상 균등 → 무의미; so the scale comes from gridDist.scaleValues)
//   grid → 그 격자의 시계열 추이(TrendChart)
// (전체 구 추이는 우클릭과 무관한 상시 overview → AllGuTrendCard 로 패널에 항상 표시.)
// Reflects the CURRENT 모드/필터; dismissible. Reuses compareBarData / colorScale / TrendChart.
import { useMemo, useState, useRef } from 'react'
import useStore from '../../store/useStore.js'
import StateOverlay from '../ui/StateOverlay.jsx'
import ResponsivePlot from './ResponsivePlot.jsx'
import TrendChart from './TrendChart.jsx'
import { baseLayout, baseConfig, MUTE, HAIRLINE } from './plotly.js'
import { compareBarData, hourCount, fullNumber, fmtCompactKo } from './aggregate.js'
import { buildColorScale } from '../../lib/colorScale.js'

const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`
const TITLE_BY_LEVEL = { gu: '행정동 분포', dong: '격자 분포', grid: '추이' }

// Bin index for a value over a scale's breaks (colorScale.binIndexFor is internal, so
// we recompute it the SAME way — keeps the pie's bins identical to the map/legend).
function binIndexFor(v, scale) {
  const breaks = scale?.breaks ?? []
  const nBins = scale?.bins?.length ?? 1
  if (breaks.length < 2) return 0
  if (v <= breaks[0]) return 0
  if (v >= breaks[breaks.length - 1]) return nBins - 1
  for (let i = 0; i < nBins; i++) if (v >= breaks[i] && v < breaks[i + 1]) return i
  return nBins - 1
}

function InspectPanel() {
  const target = useStore((s) => s.data.inspect.target)
  const loading = useStore((s) => s.data.inspect.loading)
  const error = useStore((s) => s.data.inspect.error)
  const dongCompare = useStore((s) => s.data.inspect.dongCompare)
  const gridDist = useStore((s) => s.data.inspect.gridDist)
  const trend = useStore((s) => s.data.inspect.trend)
  const hours = useStore((s) => s.selection.hours)
  const closeInspect = useStore((s) => s.closeInspect)

  const 시간수 = hourCount(hours)
  const level = target?.level

  // ── 구 → 행정동별 비교 (막대) ────────────────────────────────────────────────
  const dongBars = useMemo(() => {
    if (level !== 'gu') return null
    const { rows } = compareBarData(dongCompare.byCode, 'dong', {
      dongs: dongCompare.dongs,
      topN: Infinity,
    })
    const ordered = [...rows].reverse() // Plotly h-bars bottom→top: largest on top
    const scale = buildColorScale(dongCompare.values)
    return {
      data: [
        {
          type: 'bar',
          orientation: 'h',
          x: ordered.map((r) => r.value),
          y: ordered.map((r) => r.name),
          marker: { color: ordered.map((r) => rgbCss(scale.getColor(r.value))) },
          text: ordered.map((r) => fullNumber(r.value)),
          hovertemplate: '%{y}<br>%{text}<extra></extra>',
        },
      ],
      height: Math.min(Math.max(ordered.length * 20 + 56, 140), 560),
      n: ordered.length,
    }
  }, [level, dongCompare])

  // ── 동 → 격자 평균 분위 분포 (파이; 구 전체 스케일 기준) ──────────────────────
  const gridPie = useMemo(() => {
    if (level !== 'dong') return null
    const values = gridDist.values ?? {} // 그 동의 격자 평균
    const scaleValues = gridDist.scaleValues ?? values // 구 전체 격자 (분위 경계 기준)
    const scale = buildColorScale(scaleValues)
    const nBins = scale.bins?.length ?? 0
    if (!nBins) return { empty: true }
    const counts = new Array(nBins).fill(0)
    for (const v of Object.values(values)) {
      if (!Number.isFinite(v)) continue
      counts[binIndexFor(v, scale)] += 1
    }
    const total = counts.reduce((a, c) => a + c, 0)
    if (total === 0) return { empty: true }
    const labels = scale.bins.map((b, i) =>
      i === nBins - 1 ? `${fmtCompactKo(b.min)}+` : `${fmtCompactKo(b.min)}–${fmtCompactKo(b.max)}`,
    )
    return {
      data: [
        {
          type: 'pie',
          values: counts,
          labels,
          marker: { colors: scale.bins.map((b) => rgbCss(b.color)), line: { color: '#fff', width: 1 } },
          sort: false,
          direction: 'clockwise',
          textinfo: 'percent',
          textfont: { size: 10 },
          hovertemplate: '%{label}<br>%{value}개 (%{percent})<extra></extra>',
        },
      ],
      total,
    }
  }, [level, gridDist])

  // ── 드래그 이동 (헤더 잡고 옮기기) ───────────────────────────────────────────
  // `pos`(container px) once moved; null = default(top-center). Pointer-capture on the
  // header so the drag tracks even when the cursor leaves it; clamped within .mapview.
  const [pos, setPos] = useState(null)
  const dragRef = useRef(null)
  const onDragDown = (e) => {
    if (e.target.closest('button')) return // not when grabbing the ✕
    const popup = e.currentTarget.parentElement // .inspect-popup
    const rect = popup.getBoundingClientRect()
    const parent = popup.offsetParent
    const pr = parent?.getBoundingClientRect() ?? { left: 0, top: 0 }
    dragRef.current = {
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
      pl: pr.left,
      pt: pr.top,
      pw: parent?.clientWidth ?? window.innerWidth,
      ph: parent?.clientHeight ?? window.innerHeight,
      w: rect.width,
      h: rect.height,
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onDragMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const left = Math.max(0, Math.min(e.clientX - d.pl - d.offX, d.pw - d.w))
    const top = Math.max(0, Math.min(e.clientY - d.pt - d.offY, d.ph - d.h))
    setPos({ left, top })
  }
  const onDragUp = (e) => {
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  if (!target) return null
  const title = `${target.name ?? target.code} · ${TITLE_BY_LEVEL[level] ?? '분석'}`

  return (
    <div
      className="inspect-popup"
      role="dialog"
      aria-label={title}
      style={{
        position: 'absolute',
        // default = top-center; once dragged, an explicit left/top (container px).
        ...(pos
          ? { left: pos.left, top: pos.top }
          : { top: 'var(--sp-md)', left: '50%', transform: 'translateX(-50%)' }),
        zIndex: 3, // above legend(2)/tooltip(3); below the busy veil(4)
        width: 360,
        maxWidth: 'calc(100% - 2 * var(--sp-md))',
        maxHeight: 'calc(100% - 2 * var(--sp-md))',
        overflowY: 'auto',
        background: 'var(--canvas)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        boxShadow: 'none',
        padding: 'var(--sp-sm)',
      }}
    >
      {/* header (drag handle: 잡고 옮기기) + ✕ */}
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        onPointerCancel={onDragUp}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-sm)', marginBottom: 'var(--sp-xs)', cursor: 'move', touchAction: 'none', userSelect: 'none' }}
      >
        <span className="t-caption" style={{ color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <button
          type="button"
          onClick={closeInspect}
          aria-label="분석 닫기"
          className="t-body-strong"
          style={{ flex: '0 0 auto', border: '1px solid var(--hairline)', background: 'var(--canvas)', color: 'var(--ink)', borderRadius: 'var(--r)', width: 22, height: 22, lineHeight: 1, cursor: 'pointer', padding: 0 }}
        >
          ✕
        </button>
      </div>

      {error ? (
        <StateOverlay state="error" message={error} minHeight={120} />
      ) : loading ? (
        <StateOverlay state="loading" minHeight={120} />
      ) : level === 'grid' ? (
        <TrendChart mode={trend.mode} points={trend.points} recent30={trend.recent30} sameWeekday={trend.sameWeekday} 시간수={시간수} />
      ) : level === 'dong' ? (
        gridPie?.empty ? (
          <StateOverlay state="empty" minHeight={120} />
        ) : (
          <div>
            <ResponsivePlot
              data={gridPie.data}
              layout={{ ...baseLayout, height: 240, margin: { l: 8, r: 8, t: 8, b: 8 }, showlegend: true, legend: { font: { size: 9 }, orientation: 'v' } }}
              config={baseConfig}
              style={{ width: '100%', height: '240px' }}
              useResizeHandler
            />
            <div className="t-caption-sm" style={{ color: 'var(--mute)', marginTop: 'var(--sp-xxs)' }}>
              격자 {gridPie.total}개 · 색 = 분위 그룹(구 전체 기준, 지도·범례와 동일)
            </div>
          </div>
        )
      ) : (
        // gu: 행정동별 비교
        dongBars && dongBars.n > 0 ? (
          <ResponsivePlot
            data={dongBars.data}
            layout={{
              ...baseLayout, height: dongBars.height, margin: { l: 88, r: 16, t: 4, b: 28 },
              xaxis: { title: { text: '평균 생활인구', font: { size: 10, color: MUTE } }, showgrid: false, zeroline: true, zerolinecolor: HAIRLINE, linecolor: HAIRLINE, ticks: 'outside', tickfont: { size: 9, color: MUTE }, automargin: true },
              yaxis: { showgrid: false, zeroline: false, linecolor: HAIRLINE, tickfont: { size: 10 }, automargin: true },
            }}
            config={baseConfig}
            style={{ width: '100%' }}
            useResizeHandler
          />
        ) : (
          <StateOverlay state="empty" minHeight={100} />
        )
      )}
    </div>
  )
}

export default InspectPanel
