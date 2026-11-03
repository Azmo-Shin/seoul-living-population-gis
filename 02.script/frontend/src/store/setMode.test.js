// @vitest-environment node
//
// Tests for the setMode↔period coupling (Task 4). setMode(mode) must reset
// selection.period to a VALID default for the new mode derived from data.range,
// so a mode switch never sends a malformed period (which would 400). We mock the
// HTTP client (debounced fetchAll is harmless here) and assert the SYNC selection
// update — the period reformat happens before any fetch is scheduled.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api/client.js', () => ({
  getHealth: vi.fn(() => Promise.resolve({ ok: true })),
  getRange: vi.fn(() => Promise.resolve({})),
  getDistricts: vi.fn(() => Promise.resolve([])),
  getDongs: vi.fn(() => Promise.resolve([])),
  getGeo: vi.fn(() => Promise.resolve({ features: [] })),
  postDay: vi.fn(() => Promise.resolve({ series: [] })),
  postQuery: vi.fn(() => Promise.resolve({ features: [], 일수: 1 })),
}))

const { default: useStore } = await import('./useStore.js')

const RANGE = {
  day: { min: '2024-01-01', max: '2026-06-05' },
  month: { min: '2024-01', max: '2026-06' },
  week: { min: '2024-01', max: '2026-23' },
}

beforeEach(() => {
  useStore.setState((s) => ({
    data: { ...s.data, range: RANGE },
    selection: {
      level: 'gu',
      gu: null,
      dong: null,
      mode: 'month',
      period: '202606',
      hours: [],
      weekday: '전체',
      sex: '전체',
      ages: [],
    },
  }))
})

describe('setMode period coupling', () => {
  it("day → period = range.day.max ('YYYY-MM-DD')", () => {
    useStore.getState().setMode('day')
    const { selection } = useStore.getState()
    expect(selection.mode).toBe('day')
    expect(selection.period).toBe('2026-06-05')
  })

  it("week → period = range.week.max ('YYYY-WW', as-is)", () => {
    useStore.getState().setMode('week')
    const { selection } = useStore.getState()
    expect(selection.mode).toBe('week')
    expect(selection.period).toBe('2026-23')
  })

  it("month → period = range.month.max with dash stripped ('YYYYMM')", () => {
    useStore.getState().setMode('day') // move off month first
    useStore.getState().setMode('month')
    const { selection } = useStore.getState()
    expect(selection.mode).toBe('month')
    expect(selection.period).toBe('202606')
  })

  it('falls back to a safe constant when range is not loaded (no crash)', () => {
    useStore.setState((s) => ({ data: { ...s.data, range: null } }))
    useStore.getState().setMode('month')
    expect(useStore.getState().selection.period).toBe('202506')
  })
})
