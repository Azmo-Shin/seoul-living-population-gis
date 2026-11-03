// Spinner — the plan's ONE sanctioned green affordance ("로딩 스피너(그린)"). A thin
// rotating arc/ring: green top border over a hairline track. Flat/angular (no
// shadow). Size + thickness via props. Used inside StateOverlay (panel cards) and
// the map's always-mounted loading veil.
//
// a11y: by default the Spinner is its OWN polite live region (role="status" +
// aria-label) for any standalone use. But when it sits INSIDE an already-labeled
// status/alert container (StateOverlay, MapOverlay) that container owns the single
// live region — a nested one would create competing/duplicate announcements. In
// that case pass `decorative` to make the Spinner purely presentational
// (aria-hidden, no role/label) so there is exactly ONE live region per state.
import './Spinner.css'

/**
 * @param {{
 *   size?: number,        // outer diameter in px (default 24)
 *   thickness?: number,   // ring border width in px (default 3)
 *   label?: string,       // accessible label (default '로딩 중')
 *   decorative?: boolean, // presentational mode for use inside a labeled status
 *                         // container: aria-hidden, no role/label (default false)
 *   style?: object,
 * }} props
 */
function Spinner({
  size = 24,
  thickness = 3,
  label = '로딩 중',
  decorative = false,
  style,
}) {
  // Decorative → drop the live region (role/aria-label) and hide from SR entirely,
  // since the surrounding container already announces the loading state.
  const a11y = decorative
    ? { 'aria-hidden': true }
    : { role: 'status', 'aria-label': label }
  return (
    <span
      className="spinner"
      {...a11y}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderWidth: `${thickness}px`,
        ...style,
      }}
    />
  )
}

export default Spinner
