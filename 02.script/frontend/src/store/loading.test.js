// @vitest-environment node
//
// Task 8 §C: navigation (drillTo / toggleGridView / resetScope) must set
// data.loading=true SYNCHRONOUSLY at its start (so the map overlay shows for the
// WHOLE drill, not just the fetchAll tail), and the newest fetchAll's finally must
// always clear it back to false (race guard intact — no stuck-loading).
//
// We make geo + query deferred so we can observe the in-flight loading state
// before resolving, then confirm it clears.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Deferred resolvers for getGeo (drill geo) and postQuery (fetchAll).
const geoPending = []
const queryPending = []
vi.mock('../api/client.js', () => ({
  getHealth: vi.fn(() => Promise.resolve({ ok: true })),
  getRange: vi.fn(() => Promise.resolve({})),
  getDistricts: vi.fn(() => Promise.resolve([])),
  getDongs: vi.fn(() => Promise.resolve([])),
  getGeo: vi.fn(() => new Promise((resolve) => geoPending.push(resolve))),
  postDay: vi.fn(() => Promise.resolve({ series: [] })),
  postQuery: vi.fn(() => new Promise((resolve) => queryPending.push(resolve))),
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
  dayseries: [],
  일수: null,
  loading: false,
  error: null,
  healthy: null,
})

const freshSelection = () => ({
  level: 'gu',
  gu: null,
  dong: null,
  mode: 'month',
  period: '202506',
  hours: [],
  weekday: '전체',
  sex: '전체',
  ages: [],
})

beforeEach(() => {
  geoPending.length = 0
  queryPending.length = 0
  useStore.setState({
    data: freshData(),
    selection: freshSelection(),
    _initialized: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// Flush microtasks so awaited continuations run between assertions.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('loading covers the whole navigation (Task 8 §C)', () => {
  it('drillTo sets loading=true synchronously (before any await resolves)', () => {
    // Don't await — inspect state immediately after the synchronous portion runs.
    useStore.getState().drillTo('dong', '11680')
    const { data, selection } = useStore.getState()
    expect(data.loading).toBe(true) // set in the FIRST sync `set(...)`
    expect(data.error).toBeNull()
    expect(selection.level).toBe('dong')
    expect(selection.gu).toBe('11680')
  })

  it('loading stays true through the geo fetch, then clears after fetchAll resolves', async () => {
    const done = useStore.getState().drillTo('dong', '11680')

    // Still loading while the dong geo is in flight.
    expect(useStore.getState().data.loading).toBe(true)
    expect(geoPending.length).toBeGreaterThan(0)

    // Resolve the geo (getDongs is immediate; getGeo is the deferred one). drillTo
    // uses Promise.all([getDongs, getGeo]) → resolve every queued getGeo.
    geoPending.forEach((resolve) => resolve({ features: [] }))
    await flush()

    // Now fetchAll is in flight (postQuery deferred); still loading.
    expect(useStore.getState().data.loading).toBe(true)
    expect(queryPending.length).toBeGreaterThan(0)

    // Resolve the query → finally clears loading.
    queryPending.forEach((resolve) => resolve({ features: [], 일수: 1 }))
    await done

    expect(useStore.getState().data.loading).toBe(false)
    expect(useStore.getState().data.error).toBeNull()
  })

  it('toggleGridView (→grid) sets loading=true synchronously', () => {
    // Pre-seed: drilled into a gu at dong level.
    useStore.setState((s) => ({
      selection: { ...s.selection, level: 'dong', gu: '11680', dong: null },
    }))
    useStore.getState().toggleGridView()
    const { data, selection } = useStore.getState()
    expect(data.loading).toBe(true)
    expect(selection.level).toBe('grid')
  })

  it('resetScope sets loading=true synchronously', () => {
    useStore.setState((s) => ({
      selection: { ...s.selection, level: 'dong', gu: '11680', dong: null },
    }))
    useStore.getState().resetScope()
    const { data, selection } = useStore.getState()
    expect(data.loading).toBe(true)
    expect(selection.level).toBe('gu')
    expect(selection.gu).toBeNull()
  })

  it('a superseded drill does not leave loading stuck (newest fetchAll owns it)', async () => {
    // Start drill A, then immediately start drill B (B bumps _seq, supersedes A).
    const aDone = useStore.getState().drillTo('dong', '11110')
    const bDone = useStore.getState().drillTo('dong', '11680')

    expect(useStore.getState().data.loading).toBe(true)

    // Resolve ALL pending geo (both A's and B's). A's resolver is now stale → bails.
    geoPending.forEach((resolve) => resolve({ features: [] }))
    await flush()

    // Resolve ALL pending queries. Only the newest (B's) finally clears loading;
    // A's stale resolver is a no-op. Either way, loading must end false.
    queryPending.forEach((resolve) => resolve({ features: [], 일수: 1 }))
    await Promise.allSettled([aDone, bDone])

    expect(useStore.getState().data.loading).toBe(false)
    expect(useStore.getState().selection.gu).toBe('11680') // B won
  })
})
