// @vitest-environment node
//
// Regression test for the async race fix (Fix 1): a stale (earlier) response must
// NOT overwrite a newer one. We mock the API client so postQuery returns deferred
// promises we resolve OUT OF ORDER, then assert the store keeps the NEWER request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the HTTP client. postQuery returns a promise whose resolver we capture so
// the test controls resolution order. The other exports are harmless stubs.
const pending = []
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

// Import AFTER vi.mock so the store binds to the mocked client.
const { default: useStore } = await import('./useStore.js')

// A clean baseline of the store's data slice for each test.
const freshData = () => ({
  range: null,
  districts: [],
  dongs: [],
  districtsGeo: null,
  dongsGeo: null,
  gridsGeo: null,
  values: {},
  valuesByCode: {},
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
    _initialized: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// Build a /api/query response with one feature carrying a known 합계. The store now
// derives 평균 생활인구 = 합계 / (일수 × 시간수). With 일수=1 and the test selection's
// hours=[] (→ 시간수=24), the stored color value is 합계/24 (e.g. 222 → 9.25).
const resp = (sum) => ({ features: [{ code: 'X', 합계: sum, 일평균: null }], 일수: 1 })
const avg24 = (sum) => sum / 24 // 일수 1 × 시간수 24

describe('fetchAll race guard (Fix 1)', () => {
  it('drops the stale earlier response; the newer request wins', async () => {
    const { fetchAll } = useStore.getState()

    // Request A (myseq=1), then immediately request B (myseq=2).
    const aDone = fetchAll()
    const bDone = fetchAll()

    // Two queries are in flight; their resolvers are queued in order [A, B].
    expect(pending).toHaveLength(2)
    const [resolveA, resolveB] = pending

    // Resolve B FIRST (the newer request) with B-data...
    resolveB(resp(222))
    await bDone
    // ...then resolve A LAST (the stale request) with A-data.
    resolveA(resp(111))
    await aDone

    // The store must hold B's data (222→avg), NOT the stale A's (111→avg).
    const { data } = useStore.getState()
    expect(data.values).toEqual({ X: avg24(222) }) // 9.25
    expect(data.valuesByCode).toEqual({
      X: { 합계: 222, 일평균: null, 평균: avg24(222) },
    })
    // And loading must be false (B owns it; the stale A resolver must not touch it).
    expect(data.loading).toBe(false)
    expect(data.error).toBeNull()
  })

  it('keeps loading owned by the newest request when a stale resolver lands first', async () => {
    const { fetchAll } = useStore.getState()

    const aDone = fetchAll() // myseq=1
    const bDone = fetchAll() // myseq=2
    expect(pending).toHaveLength(2)
    const [resolveA, resolveB] = pending

    // Stale A resolves FIRST: it must be a no-op (not clear loading, not write data).
    resolveA(resp(111))
    await aDone
    let { data } = useStore.getState()
    expect(data.loading).toBe(true) // still loading — B is the owner and hasn't resolved
    expect(data.values).toEqual({}) // A's data was dropped

    // Now B resolves and wins.
    resolveB(resp(999))
    await bDone
    ;({ data } = useStore.getState())
    expect(data.values).toEqual({ X: avg24(999) }) // 41.625
    expect(data.loading).toBe(false)
  })
})
