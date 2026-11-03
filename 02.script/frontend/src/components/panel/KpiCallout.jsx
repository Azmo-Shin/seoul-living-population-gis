// KpiCallout — the headline stats for the CURRENT scope, as a flat callout Card.
//
// CRITICAL (green-budget): the big numbers are INK, not green. The choropleth map
// already owns green as the DATA encoding; on this panel green is reserved for the
// CompareBar series + the Card's corner-square. So KPI numbers use var(--ink) with
// .t-display-lg (36px/700). The card's green corner-square is the sanctioned accent.
//
// Headline metric (ALL modes): a SINGLE stat "평균 생활인구" — the average number of
// people present in the current scope during the selected day×hour window. This is
// Σ over codes of valuesByCode[code].평균 (the store already derived 평균 per code:
// month/week 합계/(일수×시간수); day Σ-selected-hours/시간수). The old person-hours
// 합계/일평균 are no longer DISPLAYED (they remain inside valuesByCode, unused here).
//
// Numbers are abbreviated for Korean readers (억/만) with the full value carried in
// a title attribute. Loading/empty/error are delegated to the shared StateOverlay
// (Task 8) so the placeholder markup lives in exactly one place.
import useStore from '../../store/useStore.js'
import Card from '../ui/Card.jsx'
import StateOverlay from '../ui/StateOverlay.jsx'
import { derivePanelState } from './panelState.js'
import { averageTotal, fmtCompactKo, fullNumber } from './aggregate.js'

function KpiCallout() {
  const mode = useStore((s) => s.selection.mode)
  const valuesByCode = useStore((s) => s.data.valuesByCode)
  const dayseries = useStore((s) => s.data.dayseries)
  // Narrow primitives for derivePanelState — NOT the whole `data` object — so this
  // card re-renders only when these slices change, not on every unrelated `data` write.
  const loading = useStore((s) => s.data.loading)
  const error = useStore((s) => s.data.error)
  // Compare (swipe) mode → also show B's average + the A→B delta.
  const compareMode = useStore((s) => s.compareMode)
  const valuesByCodeB = useStore((s) => s.data.valuesByCodeB)

  // Shared loading/empty/error precedence (error > loading > empty > ok).
  const overlay = derivePanelState(
    { loading, error, valuesByCode, dayseries },
    mode,
  )

  // Single headline: scope-wide average population over the selected window.
  const { total } = averageTotal(valuesByCode)
  const { total: totalB } = averageTotal(valuesByCodeB)

  return (
    <Card title="현재 영역 요약">
      {overlay ? (
        <StateOverlay state={overlay} message={error} minHeight={56} />
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-lg)',
            paddingTop: 'var(--sp-xs)',
          }}
        >
          {compareMode ? (
            <CompareStats a={total} b={totalB} />
          ) : (
            <Stat label="평균 생활인구" value={total} unit="명" />
          )}
        </div>
      )}
    </Card>
  )
}

// Compare KPI: A / B averages side-by-side + the Δ (B−A absolute and % change). A/B
// numbers stay INK; the Δ uses the error/success tokens for down/up so the direction
// reads at a glance (this is data semantics, not chrome — the green budget allows the
// success token here, mirroring CompareBar). Falls back to ink/— when A is 0/empty.
function CompareStats({ a, b }) {
  const delta = b - a
  const pct = a !== 0 && Number.isFinite(a) ? (delta / a) * 100 : null
  const up = delta > 0
  const flat = delta === 0 || !Number.isFinite(delta)
  const deltaColor = flat
    ? 'var(--mute)'
    : up
      ? 'var(--success)'
      : 'var(--error)'
  const sign = up ? '+' : '' // '−' is already carried by a negative number's toLocale
  const pctText =
    pct == null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-md)',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--sp-lg)' }}>
        <MiniStat label="A 평균 생활인구" value={a} />
        <MiniStat label="B 평균 생활인구" value={b} />
      </div>
      <div>
        <div
          className="t-caption"
          style={{ color: 'var(--mute)', marginBottom: 'var(--sp-xxs)' }}
        >
          Δ (B − A)
        </div>
        <div
          className="t-body-strong"
          style={{ color: deltaColor }}
          title={`${sign}${fullNumber(delta)} 명 (${pctText})`}
        >
          {sign}
          {fmtCompactKo(delta)}명
          <span style={{ marginLeft: 'var(--sp-sm)' }}>{pctText}</span>
        </div>
      </div>
    </div>
  )
}

// A compact A/B stat: caption label + medium INK number (smaller than the solo Stat
// so two fit side-by-side). Full value in the title attr.
function MiniStat({ label, value }) {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <div
        className="t-caption"
        style={{ color: 'var(--mute)', marginBottom: 'var(--sp-xxs)' }}
      >
        {label}
      </div>
      <div
        className="t-heading-md"
        style={{ color: 'var(--ink)', lineHeight: 1.1 }}
        title={`${fullNumber(value)} 명`}
      >
        {fmtCompactKo(value)}
        <span
          className="t-body-sm"
          style={{ color: 'var(--stone)', marginLeft: 'var(--sp-xxs)' }}
        >
          명
        </span>
      </div>
    </div>
  )
}

// One callout stat: big INK number (.t-display-lg) + caption label + small unit.
// `title` carries the FULL ko-KR value so precision is never lost behind 억/만.
function Stat({ label, value, unit }) {
  return (
    <div>
      <div
        className="t-caption"
        style={{ color: 'var(--mute)', marginBottom: 'var(--sp-xxs)' }}
      >
        {label}
      </div>
      <div
        className="t-display-lg"
        style={{ color: 'var(--ink)', lineHeight: 1.1 }}
        title={`${fullNumber(value)} ${unit}`}
      >
        {fmtCompactKo(value)}
        <span
          className="t-body-sm"
          style={{ color: 'var(--stone)', marginLeft: 'var(--sp-xs)' }}
        >
          {unit}
        </span>
      </div>
    </div>
  )
}

export default KpiCallout
