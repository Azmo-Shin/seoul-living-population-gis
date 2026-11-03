// @vitest-environment node
//
// Compare (swipe) mode — STAGE 1 store behavior. Covers:
//   - toggleCompare ON: flips compareMode, seeds selectionB from A's filters,
//     and fetchB populates data.valuesB / data.valuesByCodeB.
//   - setBPeriod refetches B (its own debounce timer) without touching A.
//   - toggleCompare OFF: clears compareMode/selectionB and B's data.
//   - fetchB no-ops when compare is off.
//   - the `_seqB` race guard drops a stale B response.
//
// The HTTP client is mocked so postQuery returns deferred promises we resolve in a
// controlled order (mirrors race.test.js).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const pending = [] // queued postQuery resolvers (controlled resolution order)
vi.mock('../api/client.js', () => ({
  getHealth: vi.fn(() => Promise.resolve({ ok: true })),
  getRange: vi.fn(() => Promise.resolve({})),
  getDistricts: vi.fn(() => Promise.resolve([])),
  getDongs: vi.fn(() => Promise.resolve([])),
  getGeo: vi.fn(() => Promise.resolve({ features: [] })),
  postDay: vi.fn(() => Promise.resolve({ series: [] })),
  postQuery: vi.fn(
    () =>
      new Promise((resolve) => {
        pending.push(resolve)
      }),
  ),
}))

const { default: useStore } = await import('./useStore.js')

const freshData = () => ({
  range: null,
  districts: [],
  dongs: [],
  districtsGeo: null,
  dongsGeo: null,
  gridsGeo: null,
  values: {},
  valuesByCode: {},
  valuesB: {},
  valuesByCodeB: {},
  dayseries: [],
  일수: null,
  loading: false,
  error: null,
  healthy: null,
})

beforeEach(() => {
  pending.length = 0
  useStore.setState({
    data: freshData(),
    selection: {
      level: 'gu',
      gu: null,
      dong: null,
      mode: 'month',
      period: '202506',
      hours: [],
      weekday: '전체',
      sex: '전체',
      ages: [],
    },
    compareMode: false,
    selectionB: null,
    _initialized: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// One-feature /api/query response; the store derives 평균 = 합계/(일수×시간수).
const resp = (sum) => ({ features: [{ code: 'X', 합계: sum, 일평균: null }], 일수: 1 })
const avg24 = (sum) => sum / 24 // 일수 1 × 시간수 24 (hours=[] → all)

describe('compare mode (STAGE 1)', () => {
  it('toggleCompare ON seeds selectionB from A and fetchB populates valuesB', async () => {
    const { toggleCompare } = useStore.getState()
    toggleCompare() // ON → seeds B from A, fires fetchB (one postQuery in flight)

    let s = useStore.getState()
    expect(s.compareMode).toBe(true)
    // B's filters are a COPY of A's (arrays not shared).
    expect(s.selectionB).toEqual({
      period: '202506',
      sex: '전체',
      ages: [],
      hours: [],
      weekday: '전체',
    })
    expect(s.selectionB.ages).not.toBe(s.selection.ages)

    expect(pending).toHaveLength(1)
    pending[0](resp(480))
    await Promise.resolve() // let fetchB's await chain settle
    await Promise.resolve()

    s = useStore.getState()
    expect(s.data.valuesB).toEqual({ X: avg24(480) })
    expect(s.data.valuesByCodeB).toEqual({
      X: { 합계: 480, 일평균: null, 평균: avg24(480) },
    })
    // A's own values must be untouched by a B fetch.
    expect(s.data.values).toEqual({})
  })

  it('setBPeriod updates selectionB and refetches B (debounced) without touching A', async () => {
    const { toggleCompare } = useStore.getState()
    toggleCompare()
    expect(pending).toHaveLength(1)
    pending[0](resp(240)) // initial B
    await Promise.resolve()
    await Promise.resolve()

    // Change ONLY B's period → debounced fetchB after 250ms.
    useStore.getState().setBPeriod('202406')
    expect(useStore.getState().selectionB.period).toBe('202406')
    // A's selection.period is unchanged.
    expect(useStore.getState().selection.period).toBe('202506')

    await new Promise((r) => setTimeout(r, 300)) // let B's debounce fire
    expect(pending).toHaveLength(2)
    pending[1](resp(960))
    await Promise.resolve()
    await Promise.resolve()

    expect(useStore.getState().data.valuesB).toEqual({ X: avg24(960) })
  })

  it('toggleCompare OFF clears compareMode, selectionB, and B data', async () => {
    const { toggleCompare } = useStore.getState()
    toggleCompare()
    pending[0]?.(resp(120))
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().data.valuesB).toEqual({ X: avg24(120) })

    toggleCompare() // OFF
    const s = useStore.getState()
    expect(s.compareMode).toBe(false)
    expect(s.selectionB).toBeNull()
    expect(s.data.valuesB).toEqual({})
    expect(s.data.valuesByCodeB).toEqual({})
  })

  it('fetchB no-ops when compare is off', async () => {
    await useStore.getState().fetchB()
    expect(pending).toHaveLength(0)
    expect(useStore.getState().data.valuesB).toEqual({})
  })

  it('setBSex updates selectionB.sex and refetches B (debounced) without touching A', async () => {
    const { toggleCompare } = useStore.getState()
    toggleCompare()
    expect(pending).toHaveLength(1)
    pending[0](resp(240)) // initial B
    await Promise.resolve()
    await Promise.resolve()

    // Change ONLY B's 성별 → debounced fetchB after 250ms; A's sex stays 전체.
    useStore.getState().setBSex('남')
    expect(useStore.getState().selectionB.sex).toBe('남')
    expect(useStore.getState().selection.sex).toBe('전체')

    await new Promise((r) => setTimeout(r, 300)) // let B's debounce fire
    expect(pending).toHaveLength(2)
    pending[1](resp(120))
    await Promise.resolve()
    await Promise.resolve()

    expect(useStore.getState().data.valuesB).toEqual({ X: avg24(120) })
    // A's own values untouched (still empty — A never fetched here).
    expect(useStore.getState().data.values).toEqual({})
  })

  it('resetBToA copies A filters into B and refetches B', async () => {
    const { toggleCompare } = useStore.getState()
    toggleCompare()
    pending[0]?.(resp(240))
    await Promise.resolve()
    await Promise.resolve()

    // Diverge B from A.
    useStore.getState().setBSex('여')
    expect(useStore.getState().selectionB.sex).toBe('여')

    // Reset B back to A (A.sex is 전체) → fires fetchB directly.
    useStore.getState().resetBToA()
    expect(useStore.getState().selectionB.sex).toBe('전체')
    expect(useStore.getState().selectionB.ages).not.toBe(
      useStore.getState().selection.ages,
    )
    expect(pending).toHaveLength(2)
  })

  it('drops a stale B response (the _seqB guard keeps the newest)', async () => {
    const { toggleCompare, fetchB } = useStore.getState()
    toggleCompare() // fetchB #1 (myB=1)
    fetchB() // fetchB #2 (myB=2)
    expect(pending).toHaveLength(2)
    const [resolveA, resolveB] = pending

    resolveB(resp(720)) // newer resolves first
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().data.valuesB).toEqual({ X: avg24(720) })

    resolveA(resp(111)) // stale resolves last → must be dropped
    await Promise.resolve()
    await Promise.resolve()
    expect(useStore.getState().data.valuesB).toEqual({ X: avg24(720) })
  })
})
