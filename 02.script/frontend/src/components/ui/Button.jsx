// Button — design-system button primitive.
// Variants: 'primary' (solid green, the only green fill the design budget allows on
// actions), 'outline' (green border on canvas), 'outline-on-dark' (white border on dark
// chrome). All variants keep a 44px min touch target and 2px radius.
import { CONTROL_BASE } from './controlBase.js'

const BASE = { ...CONTROL_BASE }

const VARIANTS = {
  primary: {
    background: 'var(--green)',
    color: 'var(--on-primary)',
    border: 'none',
    padding: '11px 24px',
  },
  outline: {
    background: 'transparent',
    color: 'var(--ink)',
    border: '2px solid var(--green)',
    padding: '11px 13px',
  },
  'outline-on-dark': {
    background: 'transparent',
    color: 'var(--on-dark)',
    border: '1px solid var(--on-dark)',
    padding: '11px 13px',
  },
}

function Button({ variant = 'primary', children, type = 'button', style, ...rest }) {
  const variantStyle = VARIANTS[variant] ?? VARIANTS.primary

  return (
    <button
      type={type}
      className="t-body-strong"
      style={{ ...BASE, ...variantStyle, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Button
