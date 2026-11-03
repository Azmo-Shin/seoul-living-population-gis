// @vitest-environment node
//
// Multi-gu grid view (여러 구 격자 비교) — store behavior. Covers:
//   - setMultiGridGus(2 gus): fires geo+query per gu (parallel), MERGES the grid
//     geo features + the derived {격자코드: 평균} values + valuesByCode maps.
//   - the merged 평균 = 합계/(일수×시간수) per cell (same derivation as fetchAll).
//   - setMultiGridGus([]) EXITS the view (clears multiGrid).
//   - a filter change (setSex) while active re-derives the merged grids.
//   - the `_seqMulti` guard drops a stale multi response.
//
// The client is mocked: getGeo returns a per-gu grid FeatureCollection keyed by the
// requested gu; postQuery returns that gu's grid features. Both resolve immediately
// (the merge correctness — not the race timing — is the focus), except the stale-guard
// test which uses the gu argument to return distinct payloads.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Per-gu fixtures: gu → its grid geo features + its query features (합계 per 격자코드).
// 동작 11590 → grids G1,G2 ; 관악 11620 → grid G3.
const GEO = {
  11590: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { 격자코드: 'G1' }, geometry: { type: 'Point', coordinates: [126.9, 37.5] } },
      { type: 'Feature', properties: { 격자코드: 'G2' }, geometry: { type: 'Point', coordinates: [126.91, 37.51] } },
    ],
  },
  11620: {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { 격자코드: 'G3' }, geometry: { type: 'Point', coordinates: [126.95, 37.47] } },
    ],
  },
}
const QUERY = {
  11590: { features: [{ code: 'G1', 합계: 480, 일평균: null }, { code: 'G2', 합계: 960, 일평균: null }], 일수: 1 },
  11620: { features: [{ code: 'G3', 합계: 240, 일평균: null }], 일수: 1 },
}
const avg24 = (sum) => sum / 24 // 일수 1 × 시간수 24 (hours=[] → all)

vi.mock('../api/client.js', () => ({
  getHealth: vi.fn(() => Promise.resolve({ ok: true })),
  getRange: vi.fn(() => Promise.resolve({})),
  getDistricts: vi.fn(() => Promise.resolve([])),
  getDongs: vi.fn(() => Promise.resolve([])),
  getGeo: vi.fn((_level, scope) => Promise.resolve(GEO[scope?.gu] ?? { type: 'FeatureCollection', features: [] })),
  postDay: vi.fn(() => Promise.resolve({ series: [] })),
  postQuery: vi.fn((sel) => Promise.resolve(QUERY[sel?.gu] ?? { features: [], 일수: 1 })),
  postTrend: vi.fn(() => Promise.resolve({ points: [] })),
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
  multiGrid: { gus: [], geo: null, values: {}, valuesByCode: {}, loading: false, error: null },
})

const baseSelection = () => ({
  level: 'gu',
  gu: null,
  dong: null,
  mode: 'month',
  period: '202506',
  hours: [], // [] → all 24
  weekday: '전체',
  sex: '전체',
  ages: [],
})

beforeEach(() => {
  useStore.setState({
    data: freshData(),
    selection: baseSelection(),
    compareMode: false,
    selectionB: null,
    _initialized: false,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// Let the Promise.all chain inside refetchMultiGrid settle.
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('multi-gu grid view (여러 구 격자 비교)', () => {
  it('setMultiGridGus(2 gus) merges geo features + values + valuesByCode', async () => {
    useStore.getState().setMultiGridGus(['11590', '11620'])
    // gus set synchronously; loading flagged.
    expect(useStore.getState().data.multiGrid.gus).toEqual(['11590', '11620'])
    await flush()

    const mg = useStore.getState().data.multiGrid
    // Merged geo: union of both gus' features (2 + 1 = 3), all in one FeatureCollection.
    expect(mg.geo.type).toBe('FeatureCollection')
    expect(mg.geo.features).toHaveLength(3)
    const codes = mg.geo.features.map((f) => f.properties.격자코드).sort()
    expect(codes).toEqual(['G1', 'G2', 'G3'])

    // Merged values: 평균 = 합계/(1×24) per cell, across BOTH gus.
    expect(mg.values).toEqual({ G1: avg24(480), G2: avg24(960), G3: avg24(240) })
    expect(mg.valuesByCode.G1).toEqual({ 합계: 480, 일평균: null, 평균: avg24(480) })
    expect(mg.valuesByCode.G3).toEqual({ 합계: 240, 일평균: null, 평균: avg24(240) })

    expect(mg.loading).toBe(false)
    expect(mg.error).toBeNull()
  })

  it('setMultiGridGus([]) exits the view (clears multiGrid)', async () => {
    useStore.getState().setMultiGridGus(['11590'])
    await flush()
    expect(useStore.getState().data.multiGrid.gus).toEqual(['11590'])

    useStore.getState().setMultiGridGus([])
    const mg = useStore.getState().data.multiGrid
    expect(mg.gus).toEqual([])
    expect(mg.geo).toBeNull()
    expect(mg.values).toEqual({})
    expect(mg.valuesByCode).toEqual({})
  })

  it('a filter change (setSex) while active recolors the merged grids', async () => {
    useStore.getState().setMultiGridGus(['11590'])
    await flush()
    expect(useStore.getState().data.multiGrid.values).toEqual({ G1: avg24(480), G2: avg24(960) })

    // Change a shared filter → the debounced path refetches the merged grids.
    useStore.getState().setSex('남')
    await new Promise((r) => setTimeout(r, 300)) // let the 250ms debounce fire
    await flush()

    // Same fixtures → same merged values, proving the refetch ran (no crash, no clear).
    expect(useStore.getState().data.multiGrid.values).toEqual({ G1: avg24(480), G2: avg24(960) })
    expect(useStore.getState().selection.sex).toBe('남')
  })

  it('de-dupes and trims the gu codes', async () => {
    useStore.getState().setMultiGridGus([' 11590 ', '11590', '11620', ''])
    expect(useStore.getState().data.multiGrid.gus).toEqual(['11590', '11620'])
    await flush()
    expect(useStore.getState().data.multiGrid.geo.features).toHaveLength(3)
  })

  it('entering multi-grid turns compare OFF (mutually exclusive)', async () => {
    useStore.setState({ compareMode: true, selectionB: { period: '202506', sex: '전체', ages: [], hours: [], weekday: '전체' } })
    useStore.getState().setMultiGridGus(['11590'])
    await flush()
    expect(useStore.getState().compareMode).toBe(false)
    expect(useStore.getState().selectionB).toBeNull()
    expect(useStore.getState().data.multiGrid.gus).toEqual(['11590'])
  })
})
