// Select — styled wrapper around a native <select> (kept native for accessibility:
// keyboard + screen-reader support come for free). Token-based: canvas bg, ink text,
// hairline border, 2px radius, 44px touch target, .t-body type. The ONE sanctioned
// green on screen here is the focus ring (2px green border) — design-approved for
// inputs only. NO solid-green fill on the control itself.
import { useState } from 'react'

const BASE = {
  width: '100%',
  minHeight: '44px',
  padding: '0 12px',
  background: 'var(--canvas)',
  color: 'var(--ink)',
  borderRadius: 'var(--r)',
  fontFamily: 'var(--font)',
  cursor: 'pointer',
  appearance: 'auto',
}

function Select({
  value,
  onChange,
  options = [],
  placeholder,
  disabled = false,
  'aria-label': ariaLabel,
  ...rest
}) {
  const [focused, setFocused] = useState(false)

  // value may be null/undefined → coerce to '' so the native select doesn't warn
  // and the placeholder (value='') stays selectable as the empty state.
  const selectValue = value ?? ''

  return (
    <select
      className="t-body"
      aria-label={ariaLabel}
      value={selectValue}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        ...BASE,
        border: focused
          ? '2px solid var(--green)'
          : '1px solid var(--hairline)',
        // Compensate the 1px→2px border swap so height doesn't jump on focus.
        padding: focused ? '0 11px' : '0 12px',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      {...rest}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

export default Select
