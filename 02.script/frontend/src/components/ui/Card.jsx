// Card — the flat/angular container for the KPI panel (Task 7). Canvas bg, 1px
// hairline border, 2px radius, NO box-shadow (design rule). Optional green
// CornerSquare (the sanctioned accent) top-left, and an optional title rendered
// as an uppercase .t-caption. Body = children.
//
// Reused by KpiCallout / CompareBar / HourlyLine so the panel stays consistent.
import CornerSquare from './CornerSquare.jsx'

/**
 * @param {{
 *   title?: string,
 *   corner?: boolean,            // green corner-square (default true)
 *   cornerPosition?: string,     // CornerSquare position (default 'top-left')
 *   padding?: string,            // CSS padding (default token --sp-lg)
 *   style?: object,
 *   children?: React.ReactNode,
 * }} props
 */
function Card({
  title,
  corner = true,
  cornerPosition = 'top-left',
  padding = 'var(--sp-lg)',
  style,
  children,
}) {
  return (
    <div
      style={{
        position: 'relative', // anchor for the absolutely-positioned CornerSquare
        background: 'var(--canvas)',
        border: '1px solid var(--hairline)',
        borderRadius: 'var(--r)',
        boxShadow: 'none', // flat — no shadows anywhere in this system
        padding,
        ...style,
      }}
    >
      {corner && <CornerSquare position={cornerPosition} />}
      {title && (
        <div
          className="t-caption"
          style={{ color: 'var(--ink)', marginBottom: 'var(--sp-sm)' }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

export default Card
