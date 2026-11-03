// MapTooltip — flat hover card for the choropleth. Shows the hovered feature's
// name (구명 / 행정동명, or 격자코드 for grid), its code (muted), and the headline
// metric 평균 생활인구 with ko-KR thousands separators. Positioned at the pointer
// (offset so it doesn't sit under the cursor). When the feature has no value it
// shows "데이터 없음".
//
// Flat/angular design: canvas bg, 1px hairline border, 2px radius, NO shadow.
// Purely presentational — MapView owns the hover state and passes a `hover` blob.

// Round + ko-KR thousands separators (handles null/undefined → null caller-side).
function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null
  return Math.round(Number(n)).toLocaleString('ko-KR')
}

/**
 * @param {{
 *   x: number, y: number,
 *   name: string|null, code: string,
 *   평균: number|null|undefined,
 *   breakdown?: Array<{label:string, 평균:number}>,  // 경계 격자 portion 분해
 *   breakdownTitle?: string,                          // '겹친 구별' | '겹친 동별'
 * }|null} hover
 */
function MapTooltip({ hover }) {
  if (!hover) return null
  const { x, y, name, code, 평균, breakdown, breakdownTitle } = hover
  const avg = fmt(평균)
  const hasData = avg !== null
  // Boundary 격자 portion split (per-구 in multi-gu, per-동 in A-2). Show ONLY when the
  // cell really straddles 2+ regions (a single-region cell's one portion = the total).
  const parts = Array.isArray(breakdown)
    ? [...breakdown]
        .filter((b) => Number.isFinite(b?.평균))
        .sort((a, b) => b.평균 - a.평균)
    : []
  const overlap = parts.length >= 2

  return (
    <div
      className="map-tooltip"
      style={{
        position: 'absolute',
        // Offset from the cursor (down-right) so the pointer never covers it.
        left: x + 14,
        top: y + 14,
        pointerEvents: 'none', // never intercept map interactions
        zIndex: 3,
        maxWidth: 240,
        background: 'var(--canvas)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        boxShadow: 'none',
        padding: 'var(--sp-sm)',
      }}
    >
      <div className="t-body-strong" style={{ color: 'var(--ink)' }}>
        {name ?? code}
      </div>
      <div
        className="t-caption-sm"
        style={{ color: 'var(--mute)', marginTop: 'var(--sp-xxs)' }}
      >
        {code}
      </div>

      {hasData ? (
        <div
          style={{
            marginTop: 'var(--sp-xs)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-xxs)',
          }}
        >
          <Row label={overlap ? '평균 생활인구 (합)' : '평균 생활인구'} value={avg} />
          {overlap && (
            <>
              {/* hairline divider, then the per-region split (겹친 구별/동별 portion). */}
              <div
                style={{
                  borderTop: '1px solid var(--hairline)',
                  margin: 'var(--sp-xxs) 0',
                }}
              />
              <div className="t-caption-sm" style={{ color: 'var(--mute)' }}>
                {breakdownTitle ?? '겹친 지역별'}
              </div>
              {parts.map((b, i) => (
                <Row key={`${b.label}-${i}`} label={b.label} value={fmt(b.평균)} />
              ))}
            </>
          )}
        </div>
      ) : (
        <div
          className="t-caption-sm"
          style={{ color: 'var(--mute)', marginTop: 'var(--sp-xs)' }}
        >
          데이터 없음
        </div>
      )}
    </div>
  )
}

// One label/value row inside the tooltip body.
function Row({ label, value }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 'var(--sp-md)',
      }}
    >
      <span className="t-caption-sm" style={{ color: 'var(--mute)' }}>
        {label}
      </span>
      <span className="t-body-sm" style={{ color: 'var(--body)' }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

export default MapTooltip
