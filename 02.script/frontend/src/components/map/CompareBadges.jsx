// CompareBadges — the two "A · <period>" / "B · <period>" labels for compare (swipe)
// mode. Each is LARGE and HORIZONTALLY CENTERED within its half of the split (A in the
// LEFT half, B in the RIGHT half) so the user can read which period each side shows.
// They REPOSITION as the divider moves (recomputed from the live splitX + container
// width). Pinned near the TOP so they don't cover the map center. Flat canvas pill,
// 1px hairline, 2px radius, NO shadow, ink text — NOT green (green ≡ choropleth data).
// pointer-events:none so they never block map interaction or the divider drag.
//
// Period display follows the active mode's shape:
//   month 'YYYYMM'      → 'YYYY-MM'
//   week  'YYYY-WW'     → 'YYYY W주'
//   day   'YYYY-MM-DD'  → as-is
import useStore from '../../store/useStore.js'
import { fmtPeriod } from './formatPeriod.js'

// Each label is centered on its half's mid-x via translateX(-50%); `top` keeps it near
// the top edge (clear of the map center). Flat pill for contrast over the busy tiles.
const LABEL_BASE = {
  position: 'absolute',
  top: 20, // ~16–24px from the top, clear of the map center
  transform: 'translateX(-50%)',
  zIndex: 3, // above deck canvas / legend / tooltip chrome; below the busy veil(4)
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-xs)',
  maxWidth: '44%',
  padding: '6px 12px',
  background: 'var(--canvas)',
  border: '1px solid var(--hairline)',
  borderRadius: 'var(--r)',
  boxShadow: 'none', // flat — no shadows (design rule)
  color: 'var(--ink)',
  pointerEvents: 'none', // never intercept map interactions or the divider
  whiteSpace: 'nowrap',
}

// The A/B sigil chip — a flat ink square so the side reads at a glance (green-free).
// Bumped larger to match the bigger label text.
const SIGIL = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  background: 'var(--ink)',
  color: 'var(--on-dark)',
  borderRadius: 'var(--r)',
  fontWeight: 700,
  fontSize: 14,
  lineHeight: 1,
}

// The period text — bigger + bold so it reads over the busy Kakao tiles (green-free).
const TEXT = {
  color: 'var(--ink)',
  fontWeight: 700,
  fontSize: 16,
  lineHeight: 1.2,
}

/**
 * @param {{
 *   splitX: number,   // divider x in container pixels (center of the split)
 *   width: number,    // measured container width in pixels
 * }} props
 *
 * A is centered in the LEFT half (x ≈ splitX/2); B is centered in the RIGHT half
 * (x ≈ splitX + (width - splitX)/2). Both recompute as the divider (splitX) moves.
 */
function CompareBadges({ splitX, width }) {
  const mode = useStore((s) => s.selection.mode)
  const periodA = useStore((s) => s.selection.period)
  const periodB = useStore((s) => s.selectionB?.period)

  // Guard: until the container is measured (width>0) and the split is placed, don't
  // render (avoids a flash at x=0). MapView only mounts this with a real dividerX.
  if (!width || splitX == null) return null

  const aCenter = splitX / 2
  const bCenter = splitX + (width - splitX) / 2

  return (
    <>
      <div style={{ ...LABEL_BASE, left: aCenter }}>
        <span style={SIGIL} aria-hidden="true">
          A
        </span>
        <span style={TEXT}>{fmtPeriod(mode, periodA)}</span>
      </div>
      <div style={{ ...LABEL_BASE, left: bCenter }}>
        <span style={SIGIL} aria-hidden="true">
          B
        </span>
        <span style={TEXT}>{fmtPeriod(mode, periodB)}</span>
      </div>
    </>
  )
}

export default CompareBadges
