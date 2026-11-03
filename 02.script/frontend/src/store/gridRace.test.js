// @vitest-environment node
//
// Regression test for the GRID-GEO-LOST-ON-FILTER-CHANGE bug (Part A fix).
//
// The bug: grid geometry loads slowly (~4-7s). drillTo('grid', code) loads the geo
// guarded by a token; the OLD code captured that token as `++_seq`. But a DEBOUNCED
// filter setter (setHours/setSex/…) fires fetchAll() which ALSO does `++_seq`. So a
// filter change WHILE a grid geo load is in flight bumped `_seq`, the resolving
// geo's guard failed, its `gridsGeo` write was DROPPED, drillTo hit `if (!ok) return`
// and bailed before fetchAll → `gridsGeo` stayed null FOREVER (blank map, no error).
//
// The fix splits the tokens: geo writes are guarded by a SECOND counter `_navSeq`
// that a filter fetchAll does NOT bump. So an in-flight grid geo SURVIVES a mid-load
// filter change and completes its write.
//
// These tests would FAIL on the old single-`_seq` code (gridsGeo null) and PASS now.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Deferred resolvers: getGeo (grid geo) and postQuery (fetchAll data) are both
// controllable so we can resolve them in a precise order to reproduce the race.
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

// Pre-seeded at DONG level inside gu 11680 (Gangnam) — the state a user is in right
// before drilling a dong → grid. mode is 'month' so setHours schedules a (debounced)
// network fetchAll that bumps _seq (the trigger for the old bug).
const dongLevelSelection = () => ({
  level: 'dong',
  gu: '11680',
  dong: null,
  mode: 'month',
  period: '202506',
  hours: Array.from({ length: 24 }, (_, i) => i),
  weekday: '전체',
  sex: '전체',
  ages: [],
})

beforeEach(() => {
  geoPending.length = 0
  queryPending.length = 0
  useStore.setState({
    data: freshData(),
    selection: dongLevelSelection(),
    _initialized: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

// A grid GeoJSON FeatureCollection the load resolves with.
const GRID_GEO = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { 격자코드: 'G1' }, geometry: null },
    { type: 'Feature', properties: { 격자코드: 'G2' }, geometry: null },
  ],
}

// Flush pending microtasks so awaited continuations run between assertions.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('grid geo survives a mid-load filter change (Part A regression)', () => {
  it('keeps gridsGeo (NOT null) when setHours fires a fetchAll while the grid geo is in flight', async () => {
    // Drill dong → grid. The grid geo load (getGeo) is now PENDING (deferred).
    const drillDone = useStore.getState().drillTo('grid', '11680510')

    // Grid geo request is in flight; nothing written yet.
    expect(geoPending.length).toBe(1)
    expect(useStore.getState().data.gridsGeo).toBeNull()
    expect(useStore.getState().selection.level).toBe('grid')

    // ── The bug trigger ──────────────────────────────────────────────────────
    // User changes a filter MID-LOAD. setHours (month mode) schedules a debounced
    // fetchAll. We fire that fetchAll directly to simulate the debounce elapsing —
    // it bumps `_seq` (the data token). On the OLD code this would invalidate the
    // grid geo's guard. On the fixed code `_navSeq` is untouched, so the geo survives.
    useStore.getState().setHours([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    useStore.getState().fetchAll() // simulate the debounced refetch bumping _seq
    await flush()

    // A query (the filter fetchAll, and drill's own pending fetchAll) is now queued.
    expect(queryPending.length).toBeGreaterThan(0)

    // ── Now the slow grid geo finally resolves ──────────────────────────────────
    // On the OLD code: myseq(1) !== _seq(2 after the filter fetchAll) → write DROPPED
    //   → drillTo bailed → gridsGeo stays null (the bug).
    // On the FIXED code: myNav(1) === _navSeq(1) → write SUCCEEDS.
    geoPending.forEach((resolve) => resolve(GRID_GEO))
    await flush()

    // Resolve any in-flight queries so the drill's fetchAll can complete cleanly.
    queryPending.forEach((resolve) => resolve({ features: [], 일수: 1 }))
    await flush()
    await drillDone.catch(() => {})

    // THE KEY ASSERTION: gridsGeo is the loaded FeatureCollection, NOT null.
    const { data, selection } = useStore.getState()
    expect(data.gridsGeo).not.toBeNull()
    expect(data.gridsGeo).toBe(GRID_GEO)
    expect(data.gridsGeo.features).toHaveLength(2)
    expect(selection.level).toBe('grid')
  })

  it('a NEWER drill correctly supersedes an older grid geo load (geo A dropped, geo B wins)', async () => {
    // Drill grid A (myNav=1) for dong 11680510.
    const aDone = useStore.getState().drillTo('grid', '11680510')
    expect(geoPending.length).toBe(1)
    const resolveGeoA = geoPending[0]

    // Drill grid B (myNav=2) for a DIFFERENT dong 11680545 before A's geo resolves.
    const bDone = useStore.getState().drillTo('grid', '11680545')
    expect(geoPending.length).toBe(2)
    const resolveGeoB = geoPending[1]

    const GEO_A = { type: 'FeatureCollection', features: [{ properties: { 격자코드: 'A1' } }] }
    const GEO_B = { type: 'FeatureCollection', features: [{ properties: { 격자코드: 'B1' } }] }

    // A resolves LAST but is stale (myNav 1 !== _navSeq 2) → its write must be DROPPED.
    resolveGeoB(GEO_B)
    await flush()
    resolveGeoA(GEO_A)
    await flush()

    // Let both drills' fetchAlls settle.
    queryPending.forEach((resolve) => resolve({ features: [], 일수: 1 }))
    await flush()
    await Promise.allSettled([aDone, bDone])

    // B owns the grid layer; A's stale geo did NOT clobber it.
    const { data, selection } = useStore.getState()
    expect(data.gridsGeo).toBe(GEO_B)
    expect(data.gridsGeo).not.toBe(GEO_A)
    expect(selection.dong).toBe('11680545') // B won
  })
})
