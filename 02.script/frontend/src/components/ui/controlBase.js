// controlBase — shared style block for interactive control primitives (Button, PillTab).
// Owns the touch-target + radius + flex-centering + font + cursor convention in ONE place
// so the 44px/2px/centering rules don't drift between components. Each control spreads
// this into its own BASE and adds its component-specific properties.
export const CONTROL_BASE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '44px',
  borderRadius: 'var(--r)',
  cursor: 'pointer',
  fontFamily: 'var(--font)',
  whiteSpace: 'nowrap',
}
