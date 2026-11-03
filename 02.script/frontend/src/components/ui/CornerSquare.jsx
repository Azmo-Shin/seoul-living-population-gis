// CornerSquare — the system's signature 12x12 green corner motif (radius 0).
// Decorative only (aria-hidden). Absolutely positioned inside a `position: relative`
// parent; pick a corner with the `position` prop. Reused heavily by cards in Task 7.
const CORNERS = {
  'top-left': { top: 0, left: 0 },
  'top-right': { top: 0, right: 0 },
  'bottom-left': { bottom: 0, left: 0 },
  'bottom-right': { bottom: 0, right: 0 },
}

function CornerSquare({ position = 'top-left', style, ...rest }) {
  const corner = CORNERS[position] ?? CORNERS['top-left']

  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        width: '12px',
        height: '12px',
        background: 'var(--green)',
        borderRadius: 'var(--r-none)',
        ...corner,
        ...style,
      }}
      {...rest}
    />
  )
}

export default CornerSquare
