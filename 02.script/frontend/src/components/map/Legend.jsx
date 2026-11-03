// Legend — bottom-left overlay listing the colorScale's Spectral (blue→red) swatches
// with their value ranges, plus a "데이터 없음" gray entry. Renders the SAME bins the map fills
// with, so legend and choropleth stay perfectly consistent. Flat/angular: canvas
// bg, 1px hairline, 2px radius, NO shadow, .t-caption / .t-caption-sm typography.
//
// Purely presentational — MapView builds the scale and passes `bins` + `noDataColor`.

// Compact ko-KR number formatter. Large counts collapse to 만 (10k) units for a
// tidy legend; small numbers keep thousands separators. Always rounded.
function fmtCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const abs = Math.abs(v)
  if (abs >= 10000) {
    const man = v / 10000
    // 1 decimal for sub-100만, integer-ish above; trim a trailing .0.
    const s = (abs >= 1000000 ? Math.round(man) : Math.round(man * 10) / 10)
      .toLocaleString('ko-KR')
    return `${s}만`
  }
  return Math.round(v).toLocaleString('ko-KR')
}

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`

/**
 * @param {{
 *   title?: string,
 *   subtitle?: string,           // optional second line under the title (e.g. the period)
 *   position?: 'left'|'right',   // bottom-LEFT (default, A) or bottom-RIGHT (B)
 *   bins: Array<{min:number, max:number, color:[number,number,number]}>,
 * }} props
 *
 * In COMPARE mode the map renders this TWICE (one per side) with the SAME bins —
 * position 'left' (A) and 'right' (B) anchor it to opposite bottom corners and the
 * title/subtitle name each side + its period. Non-compare renders a single 'left' one.
 *
 * The no-data swatch is rendered OUTLINE-ONLY (transparent), matching the now
 * see-through empty cells on the map — so the Legend no longer needs a no-data
 * color from the scale.
 */
function Legend({ title = '평균 생활인구', subtitle, position = 'left', bins = [] }) {
  // Anchor to the bottom-left (A) or bottom-right (B) corner. Only the horizontal
  // edge changes; both clear the bottom UI by the same --sp-md horizontal inset.
  const sideAnchor =
    position === 'right'
      ? { right: 'var(--sp-md)' }
      : { left: 'var(--sp-md)' }
  // Kakao's basemap renders a SCALE BAR (the "Nkm" indicator) in the map's BOTTOM-LEFT
  // corner — ~19px tall, flush to the bottom edge. A bottom-LEFT legend (the single/
  // non-compare legend AND compare mode's A legend) would cover it. So the LEFT legend
  // is raised by the scale-bar height + a gap (≈19px + --sp-md) — its bottom edge clears
  // the scale bar, which stays fully readable BELOW it. The RIGHT (B) legend keeps the
  // plain --sp-md inset (no scale bar in the bottom-RIGHT corner to clear).
  const SCALE_BAR_CLEARANCE = 'calc(19px + var(--sp-md))'
  const bottomInset =
    position === 'right' ? 'var(--sp-md)' : SCALE_BAR_CLEARANCE
  return (
    <div
      className="map-legend"
      style={{
        position: 'absolute',
        ...sideAnchor,
        bottom: bottomInset,
        zIndex: 2,
        background: 'var(--canvas)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        boxShadow: 'none',
        padding: 'var(--sp-sm)',
        minWidth: 132,
      }}
    >
      <div
        className="t-caption"
        style={{
          color: 'var(--ink)',
          marginBottom: subtitle ? 'var(--sp-xxs)' : 'var(--sp-xs)',
        }}
      >
        {title}
      </div>
      {subtitle && (
        <div
          className="t-caption-sm"
          style={{ color: 'var(--mute)', marginBottom: 'var(--sp-xs)' }}
        >
          {subtitle}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--sp-xxs)',
        }}
      >
        {/* Render HIGHEST value at the TOP, descending — so the biggest (red) bin is
            on top and the no-data row sits at the very bottom. */}
        {[...bins].reverse().map((bin, i) => (
          <Row
            key={bins.length - 1 - i}
            color={bin.color}
            // Top row (i===0) is the highest bin → reads as "min+" (upper tail).
            label={
              i === 0
                ? `${fmtCompact(bin.min)}+`
                : `${fmtCompact(bin.min)} – ${fmtCompact(bin.max)}`
            }
          />
        ))}
        {/* Always show the no-data entry so empty features are explained. Its swatch
            is OUTLINE-ONLY (transparent fill + hairline) to mirror the map, where
            empty cells are now fully transparent (basemap shows through). */}
        <Row label="데이터 없음" muted outlineOnly />
      </div>
    </div>
  )
}

// One swatch + range row. `outlineOnly` renders a transparent/empty swatch (just
// the hairline border) to represent "no data" matching the see-through map cells;
// otherwise the swatch is a solid `color` fill (the Spectral blue→red data bins).
function Row({ color, label, muted = false, outlineOnly = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-xs)' }}>
      <span
        aria-hidden="true"
        style={{
          flex: '0 0 auto',
          width: 14,
          height: 14,
          // Solid Spectral hue for data bins; transparent for the no-data swatch so it
          // reads as "empty / see-through" like the map.
          background: outlineOnly ? 'transparent' : rgb(color),
          // hairline outline so a pale OR empty swatch is still visible on canvas.
          border: '1px solid var(--hairline)',
          borderRadius: 'var(--r)',
        }}
      />
      <span
        className="t-caption-sm"
        style={{ color: muted ? 'var(--mute)' : 'var(--body)', whiteSpace: 'nowrap' }}
      >
        {label}
      </span>
    </div>
  )
}

export default Legend
