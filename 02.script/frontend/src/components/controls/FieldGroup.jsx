// FieldGroup — the labeled-group wrapper every filter-rail control shares. By default
// the label sits ABOVE its control(s) (stacked) with a tight vertical rhythm. Pass
// `inline` to put the label on the SAME ROW as a single compact control (e.g. 성별 /
// 요일 / 시간대 pills) — this saves a whole line of vertical space, which is the point
// of the dense rail. `label` is rendered as a plain heading (not a <label>
// for-association, since several groups wrap multiple inputs / non-labelable UI).
function FieldGroup({ label, children, inline = false }) {
  if (inline) {
    // Label left, control(s) right, on one row. The label gets a fixed-ish min width
    // so the controls line up across the inline groups; it shrinks gracefully.
    return (
      <section className="field-group field-group--inline">
        <span className="t-caption field-group__label" style={{ color: 'var(--mute)' }}>
          {label}
        </span>
        <div className="field-group__control">{children}</div>
      </section>
    )
  }
  return (
    <section
      className="field-group"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-sm)',
      }}
    >
      <span className="t-caption field-group__label" style={{ color: 'var(--mute)' }}>
        {label}
      </span>
      {children}
    </section>
  )
}

export default FieldGroup
