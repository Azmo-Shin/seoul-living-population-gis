// @vitest-environment node
//
// Task 8 §D: derivePanelState centralizes the loading/empty/error precedence for
// the panel cards. Precedence: error > loading > empty > null(ok). "empty" only
// when a successful fetch returned no usable data for the current mode's scope.
import { describe, it, expect } from 'vitest'
import { derivePanelState } from './panelState.js'

const base = {
  loading: false,
  error: null,
  valuesByCode: {},
  dayseries: [],
}

describe('derivePanelState precedence', () => {
  it('error wins over loading and everything else', () => {
    expect(
      derivePanelState({ ...base, error: 'x', loading: true }, 'month'),
    ).toBe('error')
  })

  it('loading wins over empty (never show empty while loading)', () => {
    expect(derivePanelState({ ...base, loading: true }, 'month')).toBe('loading')
    expect(derivePanelState({ ...base, loading: true }, 'day')).toBe('loading')
  })

  it('null data → loading (pre-init safety)', () => {
    expect(derivePanelState(null, 'month')).toBe('loading')
  })
})

describe('derivePanelState empty derivation (month/week)', () => {
  it('empty when valuesByCode has 0 entries', () => {
    expect(derivePanelState({ ...base, valuesByCode: {} }, 'month')).toBe('empty')
    expect(derivePanelState({ ...base, valuesByCode: {} }, 'week')).toBe('empty')
  })

  it('ok (null) when valuesByCode has entries', () => {
    expect(
      derivePanelState(
        { ...base, valuesByCode: { X: { 합계: 1, 일평균: 1 } } },
        'month',
      ),
    ).toBe(null)
  })
})

describe('derivePanelState empty derivation (day)', () => {
  it('empty when dayseries is empty', () => {
    expect(derivePanelState({ ...base, dayseries: [] }, 'day')).toBe('empty')
  })

  it('ok (null) when dayseries has points', () => {
    expect(
      derivePanelState(
        { ...base, dayseries: [{ 시간: 0, code: 'X', 값: 5 }] },
        'day',
      ),
    ).toBe(null)
  })

  it('day mode ignores valuesByCode for emptiness (uses dayseries)', () => {
    // valuesByCode populated but dayseries empty → still empty in day mode.
    expect(
      derivePanelState(
        { ...base, valuesByCode: { X: { 합계: 1 } }, dayseries: [] },
        'day',
      ),
    ).toBe('empty')
  })
})
