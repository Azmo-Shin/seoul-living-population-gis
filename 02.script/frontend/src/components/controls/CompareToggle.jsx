// CompareToggle — the "비교 모드" on/off switch. When ON, the map splits into a swipe
// comparison (left = A, right = B) and a B-period section appears in the filter rail.
// Reflects compareMode via INK-INVERSION (active = filled ink chip), green-free (green
// is reserved for the map's data encoding + primary actions).
//   - default     : full-width 44px chip (used in the rail historically).
//   - compact      : small inline chip for the breadcrumb row (~30px, auto width).
import useStore from '../../store/useStore.js'

function CompareToggle({ compact = false }) {
  const compareMode = useStore((s) => s.compareMode)
  const toggleCompare = useStore((s) => s.toggleCompare)

  // Active = inverted ink (filled black on canvas text). Idle = outline hairline.
  const style = compareMode
    ? {
        background: 'var(--ink)',
        color: 'var(--on-dark)',
        border: '1px solid var(--ink)',
      }
    : {
        background: 'var(--canvas)',
        color: 'var(--ink)',
        border: '1px solid var(--hairline-strong)',
      }

  // Sizing: compact = dense breadcrumb-row chip; default = rail-sized 44px button.
  const sizing = compact
    ? { minHeight: '30px', padding: '4px 10px', gap: 'var(--sp-xs)' }
    : { width: '100%', minHeight: '44px', padding: '11px 13px', gap: 'var(--sp-sm)' }

  return (
    <button
      type="button"
      className={compact ? 't-button-sm' : 't-body-strong'}
      onClick={toggleCompare}
      aria-pressed={compareMode}
      style={{
        borderRadius: 'var(--r)',
        boxShadow: 'none',
        cursor: 'pointer',
        fontFamily: 'var(--font)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        whiteSpace: 'nowrap',
        ...sizing,
        ...style,
      }}
    >
      <span>비교 모드</span>
      <span
        className="t-caption-sm"
        style={{ opacity: 0.8 }}
        aria-hidden="true"
      >
        {compareMode ? 'ON' : 'OFF'}
      </span>
    </button>
  )
}

export default CompareToggle
