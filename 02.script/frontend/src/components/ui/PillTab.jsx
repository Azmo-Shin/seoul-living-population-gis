// PillTab — segmented-control tab. Active state uses INK INVERSION (black bg, white
// text), never a green fill — green is reserved for data. Works on both light surfaces
// and dark chrome via the `onDark` prop.
//   - light + inactive : transparent bg, ink text
//   - light + active   : ink bg, white text
//   - dark  + inactive : transparent bg, muted-white text
//   - dark  + active   : ink bg, white text + hairline-strong border so it reads on black
import { CONTROL_BASE } from './controlBase.js'

const BASE = {
  ...CONTROL_BASE,
  padding: '10px 18px',
  background: 'transparent',
  border: '1px solid transparent',
}

function resolveStyle(active, onDark) {
  if (active) {
    return {
      background: 'var(--ink)',
      color: 'var(--on-dark)',
      // On black chrome the ink-bg pill needs an edge to separate from the surface.
      border: onDark ? '1px solid var(--hairline-strong)' : '1px solid transparent',
    }
  }
  return {
    background: 'transparent',
    color: onDark ? 'var(--on-dark-mute)' : 'var(--ink)',
    border: '1px solid transparent',
  }
}

function PillTab({ active = false, onDark = false, onClick, children, ...rest }) {
  return (
    <button
      type="button"
      className="t-button-sm"
      aria-pressed={active}
      onClick={onClick}
      style={{ ...BASE, ...resolveStyle(active, onDark) }}
      {...rest}
    >
      {children}
    </button>
  )
}

export default PillTab
