// GridToggle — A-2 whole-gu grid view toggle. Only meaningful on a gu's screen, so
// it renders ONLY when a gu is selected (hidden at the Seoul/gu-list level). Calls
// toggleGridView() (dong ⇄ grid, gu-scope). Label reflects the NEXT action:
//   showing grid (level==='grid' && dong==null) → "동별로 보기"; else → "격자로 보기".
// Lives in the breadcrumb row (`compact`) — INK/HAIRLINE (green-free per the chrome
// budget): a dense outline chip, ink-inverted when the grid view is active.
import useStore from '../../store/useStore.js'

function GridToggle({ compact = false }) {
  const gu = useStore((s) => s.selection.gu)
  const level = useStore((s) => s.selection.level)
  const dong = useStore((s) => s.selection.dong)
  const toggleGridView = useStore((s) => s.toggleGridView)

  if (!gu) return null // hidden at Seoul / gu-list level

  // Whole-gu grid view = grid level with no specific dong drilled in.
  const showingGrid = level === 'grid' && dong == null

  // Active = inverted ink; idle = hairline outline. Green-free (chrome budget).
  const activeStyle = showingGrid
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

  const sizing = compact
    ? { minHeight: '30px', padding: '4px 10px' }
    : { width: '100%', minHeight: '44px', padding: '11px 13px' }

  return (
    <button
      type="button"
      className={compact ? 't-button-sm' : 't-body-strong'}
      onClick={toggleGridView}
      aria-pressed={showingGrid}
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
        ...activeStyle,
      }}
    >
      {showingGrid ? '동별로 보기' : '격자로 보기'}
    </button>
  )
}

export default GridToggle
