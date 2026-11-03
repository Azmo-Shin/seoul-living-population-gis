// StateOverlay — the SINGLE place that defines loading / empty / error markup for
// the data panels. Task 6 & 7 reviewers flagged the duplicated inline placeholders
// in KpiCallout / CompareBar / HourlyLine; this consolidates them here. Each card
// renders <StateOverlay state={...}/> in place of its number/chart when there is no
// usable data to show.
//
// Green budget: the ONLY green is the Spinner (the sanctioned loading affordance).
// empty → mute; error → error token. No shadows; flat/angular to match the system.
//
// `state` is one of 'loading' | 'empty' | 'error' (anything else → renders nothing,
// so a parent can do `state ? <StateOverlay state={state}/> : <chart/>`).
import Spinner from './Spinner.jsx'

const EMPTY_TEXT = '데이터 없음'
const LOADING_TEXT = '불러오는 중…'
const ERROR_HINT = '잠시 후 다시 시도해 주세요.'

/**
 * @param {{
 *   state?: 'loading'|'empty'|'error'|null,
 *   message?: string,     // error message (used when state==='error')
 *   minHeight?: number,   // reserve vertical space so the card doesn't collapse
 * }} props
 */
function StateOverlay({ state, message, minHeight = 64 }) {
  if (state !== 'loading' && state !== 'empty' && state !== 'error') return null

  return (
    <div
      role={state === 'error' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--sp-sm)',
        minHeight,
        paddingTop: 'var(--sp-xs)',
        textAlign: 'center',
      }}
    >
      {state === 'loading' && (
        <>
          {/* decorative: this container's role="status" already announces loading,
              so the Spinner must not be a second nested live region. */}
          <Spinner size={22} thickness={3} decorative />
          <span className="t-body-sm" style={{ color: 'var(--mute)' }}>
            {LOADING_TEXT}
          </span>
        </>
      )}

      {state === 'empty' && (
        <span className="t-body-sm" style={{ color: 'var(--mute)' }}>
          {EMPTY_TEXT}
        </span>
      )}

      {state === 'error' && (
        <>
          <span className="t-body-sm" style={{ color: 'var(--error)' }}>
            {message || '오류가 발생했습니다.'}
          </span>
          <span className="t-caption-sm" style={{ color: 'var(--mute)' }}>
            {ERROR_HINT}
          </span>
        </>
      )}
    </div>
  )
}

export default StateOverlay
