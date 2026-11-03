// Global app state (zustand) — the single source of truth for selection + data.
//
// Design split:
//   - api/client.js  → thin HTTP only.
//   - this store      → owns selection state, orchestration, and the FIXED location
//                       of the features→{code:값} conversion (via convert.js).
//
// Period-format trap: month periods are stored/sent as "YYYYMM" (NO dash, e.g.
// "202506"). /api/meta/range returns the dashed "YYYY-MM" form — that dashed form
// must NEVER be passed into a query. The default below is already no-dash.

import { create } from 'zustand'
import {
  getHealth,
  getRange,
  getDistricts,
  getDongs,
  getGeo,
  postQuery,
  postDay,
  postTrend,
  postGridBreakdown,
  postTrendAllGu,
} from '../api/client.js'
import { featuresToValues, featuresToGridDong } from './convert.js'
import {
  monthWeekAverages,
  dayAverages,
  hourCount,
} from '../components/panel/aggregate.js'

const ALL_HOURS = Array.from({ length: 24 }, (_, i) => i)

// ── Async race guards — TWO INDEPENDENT monotonic tokens ─────────────────────
//
// `_seq`  — the DATA token. Guards values/valuesByCode/일수/loading writes inside
//           fetchAll. Bumped by EVERY fetchAll (navigation AND filter refetch).
//           Rapid user actions (Task 4 fires setters fast) issue concurrent data
//           requests; an EARLIER request can resolve AFTER a later one and clobber
//           values/loading with stale data. fetchAll captures `const myseq = ++_seq`
//           at its start and, after every await, guards `if (myseq !== _seq) return`
//           before any data `set(...)`. A stale resolver becomes a no-op: it must
//           NOT touch loading, NOT proceed. Invariant: with A(1) then B(2), _seq===2
//           once B starts, so a late-resolving A is dropped — B's data + loading win.
//
// `_navSeq` — the NAVIGATION/GEO token. Guards the GEO writes (dongsGeo/gridsGeo)
//           inside drillTo / toggleGridView / resetScope. Bumped ONLY by a new
//           navigation (a scope change), NEVER by a filter fetchAll.
//
// WHY TWO COUNTERS (the grid-geo-lost-on-filter-change bug): grid geometry loads
// SLOWLY (~4-7s). A filter setter (setHours/setSex/setPeriod/…) fires a DEBOUNCED
// fetchAll that bumps `_seq`. If geo writes were ALSO guarded by `_seq`, a filter
// change DURING an in-flight grid geo load would bump `_seq`, the resolving geo's
// guard would fail, its `gridsGeo` write would be DROPPED, and drillTo would hit
// `if (!ok) return` and bail BEFORE fetchAll — leaving `gridsGeo` null FOREVER
// (values populated, but no layer → blank gray map, no spinner, no error).
// Splitting the tokens fixes this: a geo load is invalidated ONLY by a NEWER
// NAVIGATION (a different scope owns the layer), NOT by a filter refetch. So an
// in-flight geo load SURVIVES a mid-load filter change and completes its write;
// the filter's fetchAll just recolors that same geo. The two are orthogonal:
// `_navSeq` owns geo, `_seq` owns data — neither can clobber the other's writes.
let _seq = 0
let _navSeq = 0

// `_seqB` — the COMPARE-B DATA token. Independent of `_seq`/`_navSeq`. Guards the
// valuesB/valuesByCodeB writes inside fetchB so a stale B response (an earlier B
// period/filter request resolving after a newer one) can't clobber the current B
// values. fetchB captures `const myB = ++_seqB` at its start and, after every
// await, guards `if (myB !== _seqB) return` before any B `set(...)`. Kept separate
// from `_seq` because A and B fetch concurrently and must not invalidate each other.
let _seqB = 0

// `_seqInspect` — the INSPECT (우클릭 → 하위 분포) token. Independent of the others.
// Guards the data.inspect writes inside inspectArea/refetchInspect so a stale response
// (an earlier right-click OR filter request resolving after a newer one) can't clobber
// the current inspect panel. Captured as `const myI = ++_seqInspect` at the start;
// after each await, `if (myI !== _seqInspect) return` before any inspect `set(...)`.
// closeInspect bumps it so an in-flight request can't repopulate a just-closed panel.
let _seqInspect = 0

// `_seqAllGu` — the 전체 구 추이(상시 overview) token. Guards fetchAllGuTrend writes so a
// stale all-구 trend (an earlier filter/mode resolving after a newer one) can't clobber it.
let _seqAllGu = 0

// `_seqMulti` — the MULTI-GU GRID token. Independent of all the others. Guards the
// multiGrid.geo/values/valuesByCode/loading/error writes inside refetchMultiGrid so a
// stale multi-grid response (an earlier gu-set OR filter request resolving after a
// newer one) can't clobber the current merged grids. refetchMultiGrid captures
// `const myM = ++_seqMulti` at its start and, after the Promise.all await, guards
// `if (myM !== _seqMulti) return` before any multiGrid `set(...)`. setMultiGridGus
// bumps it on a clear so an in-flight load can't repopulate a just-exited view.
let _seqMulti = 0

// ── Fetch debounce (Task 4) ──────────────────────────────────────────────────
// The six FILTER setters update `selection` IMMEDIATELY (UI stays responsive —
// e.g. a slider thumb tracks the drag) but funnel the network refetch through a
// single debounced timer. Rapid changes collapse into ONE fetchAll(). The `_seq`
// race guard inside fetchAll still guarantees correctness; the debounce merely
// reduces the number of requests fired. Navigation (init/drillTo/toggleGridView/
// resetScope) bypasses this and fetches DIRECTLY so it feels instant.
const DEBOUNCE_MS = 250
let _debounceTimer = null
function _scheduleFetch(get) {
  if (_debounceTimer) clearTimeout(_debounceTimer)
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null
    get().fetchAll()
    // Multi-gu grid view shares A's filters (sex/ages/hours/weekday/period/mode), so a
    // filter change must ALSO recolor the merged grids. refetchMultiGrid no-ops when the
    // view is off (empty gus). Funneled through the SAME debounce so a flurry of filter
    // changes collapses into one A fetch + one multi refetch.
    get().refetchMultiGrid()
    // The 우클릭 분석 팝업(inspect) is filter-driven too (성별/시간/요일/모드…) — refetch
    // its sub-distribution. No-ops when no inspect target is open.
    get().refetchInspect()
    // The 전체 구 추이 overview (always shown in the panel) tracks the same filters/mode.
    get().fetchAllGuTrend()
  }, DEBOUNCE_MS)
}

// Fetch {values, byCode} for an ARBITRARY scope (level + gu/dong), mode-aware — mirrors
// fetchAll's day-vs-month/week derivation so the inspect panel's sub-distributions
// (gu→행정동 평균, dong→격자 평균) match the map's 평균 생활인구 exactly. Pure module
// helper over the API client + converters (no store access).
async function _fetchScopeValues(sel) {
  if (sel.mode === 'day') {
    const resp = await postDay(sel)
    return dayAverages(resp.series ?? [], sel.hours)
  }
  const resp = await postQuery(sel)
  const { valuesByCode } = featuresToValues(resp.features)
  return monthWeekAverages(valuesByCode, resp.일수, hourCount(sel.hours))
}
// Cancel a pending debounced fetch so a superseded filter refetch doesn't fire
// after a direct navigation fetch. Navigation actions call this first; the `_seq`
// race guard still owns correctness — this just avoids a wasted request.
function _cancelScheduledFetch() {
  if (_debounceTimer) {
    clearTimeout(_debounceTimer)
    _debounceTimer = null
  }
}

// ── Compare-B fetch debounce (separate timer from A) ─────────────────────────
// The B-filter setters (setBPeriod/setBSex/…) update selectionB immediately and
// funnel the B refetch through THIS timer — deliberately INDEPENDENT of A's
// `_debounceTimer` so a rapid A-filter change and a rapid B-filter change don't
// cancel each other's pending fetch. The `_seqB` guard inside fetchB still owns
// correctness; this just collapses a flurry of B changes into one request.
let _debounceTimerB = null
function _scheduleFetchB(get) {
  if (_debounceTimerB) clearTimeout(_debounceTimerB)
  _debounceTimerB = setTimeout(() => {
    _debounceTimerB = null
    get().fetchB()
  }, DEBOUNCE_MS)
}

// Metric fields that must be cleared on a level/scope navigation so the panel
// shows a clean loading state instead of the previous level's mismatched data
// (fetchAll repopulates them ~250ms later).
const CLEARED_METRICS = { values: {}, valuesByCode: {}, dayseries: [], 일수: null, gridDong: {}, gridBreakdown: {} }

// Default period for a given mode, derived from the loaded `range`. A mode switch
// must reset `period` to a VALID shape for the new mode or the backend 400s:
//   month → range.month.max 'YYYY-MM' → 'YYYYMM' (strip dash)
//   week  → range.week.max  'YYYY-WW' (as-is)
//   day   → range.day.max   'YYYY-MM-DD' (as-is)
// Falls back to a safe constant when `range` isn't loaded yet (never crashes).
function _defaultPeriodFor(mode, range) {
  if (mode === 'month') {
    const m = range?.month?.max
    return m ? m.replace('-', '') : '202506'
  }
  if (mode === 'week') {
    return range?.week?.max ?? '2025-01'
  }
  // day
  return range?.day?.max ?? '2025-12-31'
}

const initialSelection = {
  level: 'gu', // 'gu' | 'dong' | 'grid'
  gu: null, // 5-digit code when drilled in
  dong: null, // 8-digit code when drilled in
  mode: 'month', // 'month' | 'week' | 'day'
  period: '202506', // month:'YYYYMM' | week:'YYYY-WW' | day:'YYYY-MM-DD'
  hours: ALL_HOURS, // full 24 by default
  weekday: '전체',
  sex: '전체',
  ages: [], // [] = all
}

const initialData = {
  range: null,
  districts: [], // [{구코드,구명}] (25)
  dongs: [], // [{행정동코드,행정동명}] for current gu
  districtsGeo: null,
  dongsGeo: null,
  gridsGeo: null,
  values: {}, // { [code]: number }  — color metric = 평균 생활인구 (store-side derive)
  valuesByCode: {}, // { [code]: {합계, 일평균, 평균} } (day: {평균}) — tooltips/KPI
  // Per-grid → 행정동코드 membership { [격자코드]: 행정동코드 }. ONLY populated at the
  // grid level (the backend fills 행정동코드 on grid features only); gu/dong queries
  // leave it {}. Drives the A-2 gu-scope per-동 grid distribution (GridDongAnalysis).
  // Reset to {} on every navigation (part of CLEARED_METRICS) so a stale level's
  // membership never leaks into a new scope.
  gridDong: {}, // { [격자코드]: 행정동코드 }
  // Per-grid 행정동별 portion breakdown for the A-2 (구 전체) grid view: a boundary 격자
  // straddling 2+ 행정동 WITHIN the 구 → { [격자코드]: [{행정동코드, 행정동명, 평균}] }
  // (ONLY cells with 2+ 동). Additive: the choropleth value is still the within-gu sum;
  // this only feeds the tooltip's "총합 + 동별 분해". month/week only (day: {}). Reset on
  // nav (CLEARED_METRICS). Fetched async after the main grid query (never blocks the map).
  gridBreakdown: {},
  // ── Compare-B metric (STAGE 1) ──────────────────────────────────────────────
  // The RIGHT-half (state B) choropleth values, SAME shape as values/valuesByCode
  // but for selectionB's period/filters over A's SAME spatial scope + mode. Empty
  // unless compareMode is on. The map builds a SHARED color scale over A∪B.
  valuesB: {}, // { [code]: number }  — B's 평균 생활인구
  valuesByCodeB: {}, // { [code]: {합계, 일평균, 평균} } (day: {평균}) — B tooltips/KPI
  dayseries: [], // raw day series points (mode 'day')
  일수: null,
  loading: false,
  error: null,
  healthy: null,
  // ── Multi-gu grid view (여러 구 격자 비교) ─────────────────────────────────────
  // A SEPARATE view that shows the 250m grids of SEVERAL 구 at once, merged into one
  // choropleth + a bold 구-boundary/label overlay so each 구 is distinguishable. Kept
  // entirely apart from the single-scope selection/data above so it never tangles the
  // normal drill flow: when `gus` is non-empty the MAP renders the multiGrid layers
  // instead of the level view; an empty `gus` exits the view (back to normal).
  //   gus          — selected 구코드[] (empty = view off)
  //   geo          — UNION FeatureCollection, DEDUPED to one cell per 격자코드 (a
  //                  boundary 격자 overlaps 2+ 구, so each 구's geo returns it)
  //   values       — { [격자코드]: 평균 } SUMMED across selected 구 (color metric): a
  //                  boundary 격자 is painted with the total of its per-구 portions
  //   valuesByCode — { [격자코드]: {평균} } SUMMED (tooltip headline)
  //   breakdown    — { [격자코드]: [{구, 구명, 평균}] } per-구 portions, for the tooltip
  //                  to show the total + which 구 contributes how much on a boundary 격자
  //   loading/error — this view's own request lifecycle (independent of data.loading)
  multiGrid: {
    gus: [],
    geo: null,
    values: {},
    valuesByCode: {},
    breakdown: {},
    loading: false,
    error: null,
  },
  // ── Inspect (우클릭 → 한 단계 아래 분포, 팝업) ────────────────────────────────
  // Right-clicking an area opens a floating POPUP over the map showing the distribution
  // ONE LEVEL BELOW the clicked area (filter-/mode-driven; refetched on any selection
  // change). `target` ({level, code, name}) is non-null while the popup is open.
  //   gu 우클릭   → dongCompare (그 구의 행정동별 평균, 막대)
  //   dong 우클릭 → gridDist (그 동의 격자 평균을 **구-wide 스케일**로 묶은 파이)
  //   grid 우클릭 → trend (그 격자의 시계열 추이; month/week=points, day=recent30/sameWeekday)
  // (전체 구 추이는 우클릭과 무관한 상시 overview → 아래 allGuTrend 로 분리.)
  inspect: {
    target: null,
    loading: false,
    error: null,
    dongCompare: { byCode: {}, values: {}, dongs: [] }, // gu: 행정동 평균 + 이름
    // dong: {격자:평균}(그 동) + scaleValues {격자:평균}(구 전체, 분위 스케일 기준)
    gridDist: { values: {}, scaleValues: {} },
    trend: { mode: 'month', points: [], recent30: [], sameWeekday: [] }, // grid: 시계열
  },
  // ── 전체 구 추이 (상시 overview, 우클릭 무관) ─────────────────────────────────
  // The 25-구 추이 라인 shown by DEFAULT in the right panel (fetched on init + every
  // filter/mode change via _scheduleFetch). { byGu:{구코드:[{라벨,평균}]}, names:{구코드:구명} }.
  allGuTrend: { mode: 'month', byGu: {}, names: {}, loading: false, error: null },
}

const useStore = create((set, get) => ({
  selection: initialSelection,
  data: initialData,
  // ── Right KPI/분석 패널 펼침 (UI) ─────────────────────────────────────────────
  // Default OPEN so the 전체 구 추이 overview(AllGuTrendCard) is shown by default
  // (사용자 요청: "추이는 디폴트로 보여야"). The toggle button collapses it for map width.
  panelOpen: true,
  setPanelOpen: (v) => set({ panelOpen: !!v }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  // ── Compare (swipe) mode (STAGE 1) ──────────────────────────────────────────
  // compareMode → the map splits at a draggable divider: LEFT = state A (the
  // current `selection`), RIGHT = state B. `selectionB` holds B's FILTER overrides
  // ONLY ({period, sex, ages, hours, weekday}); B SHARES A's level/gu/dong/mode so
  // both halves are the SAME areas in the SAME mode (only period/filters differ).
  // null when compare is off. B's data lives in data.valuesB / data.valuesByCodeB.
  compareMode: false,
  selectionB: null,
  _initialized: false, // guards init() against React 19 StrictMode double-mount

  // ── Private helpers (dedup error/geo boilerplate, keep race guard consistent) ─
  // Centralize the `String(e.message ?? e)` formatting + loading:false reset.
  setError: (e) =>
    set((s) => ({
      data: { ...s.data, error: String(e?.message ?? e), loading: false },
    })),

  // Load one geo layer into data[key], guarded by the NAVIGATION token so a stale
  // resolver (superseded by a NEWER navigation) is dropped — but a filter fetchAll
  // (which bumps only `_seq`, not `_navSeq`) does NOT invalidate it. Returns true if
  // this call is still current (caller may proceed to fetchAll), false if it was
  // superseded by a newer navigation / failed and should bail.
  _loadGeo: async (myNav, key, level, scope) => {
    try {
      const geo = await getGeo(level, scope)
      if (myNav !== _navSeq) return false
      set((s) => ({ data: { ...s.data, [key]: geo } }))
      return true
    } catch (e) {
      if (myNav !== _navSeq) return false
      get().setError(e)
      return false
    }
  },

  // ── Selection setters: mutate selection IMMEDIATELY, refetch DEBOUNCED ──────
  // selection updates synchronously (responsive UI); the network refetch is
  // funneled through `_scheduleFetch` (~250ms) so a flurry of changes → ONE fetch.
  // setMode ALSO resets `period` to a valid default for the new mode (derived from
  // data.range) BEFORE scheduling, so a mode switch never sends a malformed period.
  setMode: (mode) => {
    set((s) => ({
      selection: {
        ...s.selection,
        mode,
        period: _defaultPeriodFor(mode, s.data.range),
      },
    }))
    _scheduleFetch(get)
    // Compare: B shares A's mode. A mode switch changes the period SHAPE, so B's
    // period (snapshotted in the OLD mode's shape) would 400 the backend. Reset B's
    // period to a valid default for the new mode, then refetch B (its other filters
    // are unchanged). Only when compare is active; A's own refetch is above.
    if (get().compareMode && get().selectionB) {
      set((s) => ({
        selectionB: {
          ...s.selectionB,
          period: _defaultPeriodFor(mode, s.data.range),
        },
      }))
      get().fetchB()
    }
  },
  setPeriod: (period) => {
    set((s) => ({ selection: { ...s.selection, period } }))
    _scheduleFetch(get)
  },
  setSex: (sex) => {
    set((s) => ({ selection: { ...s.selection, sex } }))
    _scheduleFetch(get)
  },
  setAges: (ages) => {
    set((s) => ({ selection: { ...s.selection, ages } }))
    _scheduleFetch(get)
  },
  // setHours is MODE-AWARE. The 시간대 filter feeds the headline 평균 생활인구 in EVERY
  // mode. In month/week the backend's 합계 depends on `hours`, so we still refetch
  // (debounced). In DAY mode the backend already returned the full 24h series, so we
  // re-derive 평균 LOCALLY from the cached series (no network) — making the hour filter
  // live and instant. Selection updates synchronously either way (responsive slider).
  setHours: (hours) => {
    set((s) => ({ selection: { ...s.selection, hours } }))
    if (get().selection.mode === 'day') {
      get()._recomputeDay() // local recompute, NO refetch
      // Multi-grid view doesn't cache the per-gu day series, so a day-mode hour change
      // re-derives the merged grids via a (small, N-gu) refetch. No-ops when off.
      if ((get().data.multiGrid?.gus?.length ?? 0) > 0) get().refetchMultiGrid()
      // The inspect panel's day data is backend-derived (hours applied), so refetch it
      // too on a day-mode hour change. No-ops when no inspect target is open.
      get().refetchInspect()
    } else {
      _scheduleFetch(get) // month/week: 합계 depends on hours → refetch (debounced)
    }
  },
  setWeekday: (weekday) => {
    set((s) => ({ selection: { ...s.selection, weekday } }))
    _scheduleFetch(get)
  },

  // ── Compare (swipe) mode actions (STAGE 1) ──────────────────────────────────
  // toggleCompare: ON → snapshot A's FILTERS into selectionB (B starts IDENTICAL to
  // A, so the two halves look the same until the user changes B), flip compareMode,
  // and fetch B's values. OFF → clear compareMode/selectionB and B's data. The B
  // setters mutate selectionB synchronously and refetch through the SEPARATE B
  // debounce timer. fetchB never throws (a B error just leaves the prior valuesB).
  toggleCompare: () => {
    if (get().compareMode) {
      // OFF — tear down compare: drop B selection + B data, leave A untouched.
      if (_debounceTimerB) {
        clearTimeout(_debounceTimerB)
        _debounceTimerB = null
      }
      set((s) => ({
        compareMode: false,
        selectionB: null,
        data: { ...s.data, valuesB: {}, valuesByCodeB: {} },
      }))
      return
    }
    // ON — seed B from A's current FILTERS (copy arrays so later B edits don't
    // mutate A's). level/gu/dong/mode are NOT stored on B — fetchB reads them live
    // from A so both halves always share the same areas + mode. Compare + multi-grid
    // are mutually exclusive, so turning compare ON exits the multi-gu grid view.
    if ((get().data.multiGrid?.gus?.length ?? 0) > 0) get().setMultiGridGus([])
    const a = get().selection
    set({
      compareMode: true,
      selectionB: {
        period: a.period,
        sex: a.sex,
        ages: [...a.ages],
        hours: [...a.hours],
        weekday: a.weekday,
      },
    })
    get().fetchB()
  },

  // B-filter setters: update the field on selectionB, then DEBOUNCED fetchB (B's
  // own timer). STAGE 1's UI only wires setBPeriod; the rest exist for STAGE 2.
  // Each guards against a null selectionB (compare off) defensively.
  setBPeriod: (period) => {
    if (!get().selectionB) return
    set((s) => ({ selectionB: { ...s.selectionB, period } }))
    _scheduleFetchB(get)
  },
  setBSex: (sex) => {
    if (!get().selectionB) return
    set((s) => ({ selectionB: { ...s.selectionB, sex } }))
    _scheduleFetchB(get)
  },
  setBAges: (ages) => {
    if (!get().selectionB) return
    set((s) => ({ selectionB: { ...s.selectionB, ages } }))
    _scheduleFetchB(get)
  },
  setBHours: (hours) => {
    if (!get().selectionB) return
    set((s) => ({ selectionB: { ...s.selectionB, hours } }))
    _scheduleFetchB(get)
  },
  setBWeekday: (weekday) => {
    if (!get().selectionB) return
    set((s) => ({ selectionB: { ...s.selectionB, weekday } }))
    _scheduleFetchB(get)
  },

  // Reset B's filters back to A's CURRENT filters (the "A로 초기화" affordance). Copies
  // A's arrays so later B edits don't mutate A's. No-op when compare is off. Refetches
  // B directly (not debounced) so the swipe re-syncs to A immediately.
  resetBToA: () => {
    if (!get().selectionB) return
    const a = get().selection
    set({
      selectionB: {
        period: a.period,
        sex: a.sex,
        ages: [...a.ages],
        hours: [...a.hours],
        weekday: a.weekday,
      },
    })
    get().fetchB()
  },

  // ── Compare-B data fetch ─────────────────────────────────────────────────────
  // Fetch B's choropleth values: A's SAME level/gu/dong/mode but B's period/filters.
  // mode==='day' → postDay + dayAverages (B simply refetches in day mode — simpler
  // than a local recompute). else → postQuery + monthWeekAverages. Race-guarded by
  // `_seqB`. NEVER throws — on error it leaves the prior valuesB (no veil flicker).
  // No-ops when compareMode is off (a stray debounced call after toggle-off).
  fetchB: async () => {
    if (!get().compareMode) return
    const a = get().selection
    const b = get().selectionB
    if (!b) return
    // B shares A's spatial scope + mode; only period/filters come from selectionB.
    const q = {
      level: a.level,
      gu: a.gu,
      dong: a.dong,
      mode: a.mode,
      period: b.period,
      sex: b.sex,
      ages: b.ages,
      hours: b.hours,
      weekday: b.weekday,
    }
    const myB = ++_seqB
    try {
      if (q.mode === 'day') {
        const resp = await postDay(q)
        if (myB !== _seqB) return
        const series = resp.series ?? []
        const { values, byCode } = dayAverages(series, b.hours)
        set((s) => ({
          data: { ...s.data, valuesB: values, valuesByCodeB: byCode },
        }))
      } else {
        const resp = await postQuery(q)
        if (myB !== _seqB) return
        const { valuesByCode: vbc } = featuresToValues(resp.features)
        const { values, byCode } = monthWeekAverages(
          vbc,
          resp.일수,
          hourCount(b.hours),
        )
        set((s) => ({
          data: { ...s.data, valuesB: values, valuesByCodeB: byCode },
        }))
      }
    } catch {
      // Swallow — leave the prior valuesB intact (don't blank B on a transient
      // error). A and B are independent; a B failure must not disturb A's veil.
      if (myB !== _seqB) return
    }
  },

  // ── Drill navigation ───────────────────────────────────────────────────────
  // gu → click a gu  → dong level (load dongs meta + dongsGeo for that gu)
  // dong → click a dong → grid level (load gridsGeo for that dong; gu stays)
  //
  // Selection set (sync) reflects latest user intent and runs first; THEN we
  // capture myNav (the NAVIGATION token) and guard the async GEO writes with it,
  // so a stale geo resolver is dropped ONLY by a NEWER navigation — NOT by a filter
  // fetchAll fired mid-load (that bumps `_seq`, not `_navSeq`; see the two-counter
  // note above — this is the grid-geo-lost-on-filter-change fix).
  drillTo: async (level, code) => {
    _cancelScheduledFetch()
    // A normal drill exits the multi-gu grid view (the two are mutually exclusive — the
    // single-scope drill flow resumes). No-op clear when multiGrid is already off.
    if ((get().data.multiGrid?.gus?.length ?? 0) > 0) get().setMultiGridGus([])
    if (level === 'dong') {
      // loading:true covers the WHOLE drill (geo fetch + fetchAll), so the map
      // overlay shows for the full transition. error:null clears any stale error.
      // loading is cleared by the newest fetchAll on BOTH its success path AND its
      // catch path, each gated by `myseq === _seq` (there is NO literal `finally`).
      // WARNING: do NOT "simplify" that dual-path clear into a real `finally` — a
      // finally runs even on the stale-guard early-return, clearing loading that a
      // newer request owns and re-introducing the exact race the guard prevents.
      set((s) => ({
        selection: { ...s.selection, level: 'dong', gu: code, dong: null },
        data: { ...s.data, ...CLEARED_METRICS, loading: true, error: null },
      }))
      const myNav = ++_navSeq
      // dongs meta + dongsGeo for that gu, both guarded by the NAVIGATION token so a
      // mid-load filter fetchAll doesn't drop the geo write.
      try {
        const [dongs, dongsGeo] = await Promise.all([
          getDongs(code),
          getGeo('dong', { gu: code }),
        ])
        if (myNav !== _navSeq) return // a NEWER navigation owns this layer now
        set((s) => ({ data: { ...s.data, dongs, dongsGeo } }))
      } catch (e) {
        if (myNav !== _navSeq) return // stale geo failure: a newer nav owns loading
        get().setError(e) // sets error + loading:false for THIS (current) nav
        return
      }
      await get().fetchAll()
      // Compare: B follows A into the new scope (B's filters unchanged). Fire-and-
      // forget — B's own _seqB guard owns correctness; never blocks A's drill.
      if (get().compareMode) get().fetchB()
    } else if (level === 'grid') {
      const gu = get().selection.gu
      set((s) => ({
        selection: { ...s.selection, level: 'grid', dong: code },
        data: { ...s.data, ...CLEARED_METRICS, loading: true, error: null },
      }))
      const myNav = ++_navSeq
      const ok = await get()._loadGeo(myNav, 'gridsGeo', 'grid', {
        dong: code,
        gu,
      })
      if (!ok) return // superseded by newer nav / failed → bail before fetchAll
      await get().fetchAll()
      if (get().compareMode) get().fetchB() // B follows A into grid scope
    }
  },

  // ── Whole-gu grid toggle (A-2), used on the gu's dong screen ────────────────
  // dong ⇄ grid with dong=null (gu-scope). To grid → load whole-gu grids;
  // back to dong → keep existing dongsGeo (already loaded for this gu).
  toggleGridView: async () => {
    _cancelScheduledFetch()
    if ((get().data.multiGrid?.gus?.length ?? 0) > 0) get().setMultiGridGus([]) // exit multi view
    const { level, gu } = get().selection
    if (level === 'grid') {
      // back to dong view: no geo load (dongsGeo already loaded for this gu), so
      // there is no await-then-write to guard here — fetchAll owns its own token.
      // loading:true is still set so the overlay shows for the (brief) refetch.
      set((s) => ({
        selection: { ...s.selection, level: 'dong', dong: null },
        data: { ...s.data, ...CLEARED_METRICS, loading: true, error: null },
      }))
      await get().fetchAll()
      if (get().compareMode) get().fetchB() // B follows A back to dong scope
      return
    }
    // → grid view (gu-scope, dong=null). loading:true covers the geo load + fetch.
    // myNav (NAVIGATION token) guards the geo write so a mid-load filter fetchAll
    // (which bumps only `_seq`) doesn't drop the gridsGeo write.
    set((s) => ({
      selection: { ...s.selection, level: 'grid', dong: null },
      data: { ...s.data, ...CLEARED_METRICS, loading: true, error: null },
    }))
    const myNav = ++_navSeq
    if (gu) {
      const ok = await get()._loadGeo(myNav, 'gridsGeo', 'grid', { gu })
      if (!ok) return // superseded by newer nav / failed → bail before fetchAll
    }
    await get().fetchAll()
    if (get().compareMode) get().fetchB() // B follows A into whole-gu grid scope
  },

  // ── Reset scope to all-of-Seoul (the gu level) ─────────────────────────────
  // Keeps mode/period/filters; drops the drill (gu/dong) + any gu-scoped geo so
  // stale dong/grid layers don't linger. Fetches DIRECTLY (navigation = instant).
  resetScope: async () => {
    _cancelScheduledFetch()
    if ((get().data.multiGrid?.gus?.length ?? 0) > 0) get().setMultiGridGus([]) // exit multi view
    // A reset IS a navigation: bump the NAVIGATION token so any in-flight geo load
    // from a prior drill (e.g. a slow grid geo) is invalidated and won't write its
    // now-stale layer back after we've cleared the scope. No geo load here —
    // districtsGeo is already loaded — but fetchAll still runs.
    ++_navSeq
    // loading:true so the overlay shows for the reset refetch.
    set((s) => ({
      selection: { ...s.selection, level: 'gu', gu: null, dong: null },
      data: {
        ...s.data,
        dongs: [],
        dongsGeo: null,
        gridsGeo: null,
        ...CLEARED_METRICS,
        loading: true,
        error: null,
      },
    }))
    await get().fetchAll()
    if (get().compareMode) get().fetchB() // B follows A back to all-of-Seoul scope
  },

  // ── Core data fetch for current selection ──────────────────────────────────
  // month/week → postQuery + store conversion (values/valuesByCode/일수).
  // day        → postDay + store raw series.
  // Never throws; on error sets data.error and clears loading.
  //
  // Race-guarded: captures myseq, and after the await drops the write if a newer
  // request has started. loading:false is cleared on BOTH paths — the success
  // `set(...)` AND the catch `set(...)` — each gated by `myseq === _seq`. There is
  // intentionally NO `finally`: a `finally` would run even on the stale-guard early
  // `return`, clearing loading the newer request now owns and re-opening the race
  // the guard closes. Keep the dual-path clear; do NOT collapse it into `finally`.
  fetchAll: async () => {
    const selection = get().selection
    const myseq = ++_seq
    set((s) => ({ data: { ...s.data, loading: true, error: null } }))
    try {
      if (selection.mode === 'day') {
        const resp = await postDay(selection)
        if (myseq !== _seq) return
        // Derive 평균 생활인구 from the full 24h series filtered to the SELECTED hours,
        // so the MAP gets day values (choropleth works in day mode) and the KPI is a
        // real average population — not the Σ-all-hours person-hours total. The raw
        // series is kept so the hour filter can recompute locally (_recomputeDay).
        const series = resp.series ?? []
        // LOAD-BEARING fresh read of selection.hours (not captured at fetch start):
        // a mid-flight setHours runs _recomputeDay synchronously; re-deriving here
        // from the FRESHEST selection.hours means this resolver correctly supersedes
        // that interim recompute. Capturing hours at fetch start would silently lose
        // a mid-flight hour change.
        const { values, byCode } = dayAverages(series, get().selection.hours)
        set((s) => ({
          data: {
            ...s.data,
            dayseries: series,
            values,
            valuesByCode: byCode,
            loading: false,
          },
        }))
      } else {
        const resp = await postQuery(selection)
        if (myseq !== _seq) return
        const { valuesByCode: vbc } = featuresToValues(resp.features)
        // Per-grid → 행정동코드 membership (grid level only; the backend fills 행정동코드
        // on grid features only). Drives the A-2 per-동 grid distribution. At gu/dong
        // levels the features carry no 행정동코드 → this is {} (the helper omits them).
        const gridDong =
          selection.level === 'grid' ? featuresToGridDong(resp.features) : {}
        // Convert the backend's person-hours 합계 into 평균 생활인구 =
        // 합계 / (일수 × 시간수). The map colors by 평균 (monotonic transform of 일평균
        // within a query → identical ranking, real-population numbers).
        const { values, byCode } = monthWeekAverages(
          vbc,
          resp.일수,
          hourCount(get().selection.hours),
        )
        set((s) => ({
          data: {
            ...s.data,
            values,
            valuesByCode: byCode,
            gridDong,
            일수: resp.일수 ?? null,
            loading: false,
          },
        }))
        // A-2 (구 전체 격자): fetch the per-동 portion breakdown for boundary cells. This
        // is ADDITIVE (the choropleth value above is already the within-gu sum) and runs
        // AFTER the main set so it never delays the map; _seq-guarded against navigations.
        if (selection.level === 'grid' && selection.dong == null && selection.gu) {
          get()._fetchGridBreakdown(selection, resp.일수, myseq)
        }
      }
    } catch (e) {
      if (myseq !== _seq) return // stale: don't touch error/loading (newer request owns them)
      set((s) => ({
        data: { ...s.data, error: String(e?.message ?? e), loading: false },
      }))
    }
  },

  // ── A-2 격자 경계셀 동별 분해 (부가 정보, 툴팁용) ─────────────────────────────
  // Fetches per-(격자, 행정동) portions for the gu-scope grid and derives a per-grid
  // breakdown [{행정동코드, 행정동명, 평균}] keyed by 격자코드 — only cells that span 2+
  // 동 (the boundary cells). 평균 = 합계 / (일수 × 시간수), mirroring the main metric.
  // Fire-and-forget + _seq-guarded: a stale or failed breakdown never disturbs the map
  // (on any error it just clears to {}). Resolves 행정동명 via data.dongs (code fallback).
  _fetchGridBreakdown: async (selection, 일수, myseq) => {
    try {
      const resp = await postGridBreakdown({
        gu: selection.gu,
        mode: selection.mode,
        period: selection.period,
        hours: selection.hours,
        weekday: selection.weekday,
        sex: selection.sex,
        ages: selection.ages,
      })
      if (myseq !== _seq) return // a newer navigation/fetch superseded this
      const 시간수 = hourCount(get().selection.hours)
      const days = Number(일수 ?? resp.일수)
      const ok = Number.isFinite(days) && days > 0 && 시간수 > 0
      const dongName = {}
      for (const d of get().data.dongs ?? []) dongName[String(d.행정동코드)] = d.행정동명
      const byGrid = {}
      for (const it of resp.items ?? []) {
        const 합계 = it?.합계
        if (!ok || !Number.isFinite(합계)) continue
        const c = String(it?.격자코드 ?? '').trim()
        const dcode = String(it?.행정동코드 ?? '').trim()
        if (!c || !dcode) continue
        ;(byGrid[c] ??= []).push({
          행정동코드: dcode,
          행정동명: dongName[dcode] ?? dcode,
          평균: 합계 / (days * 시간수),
        })
      }
      // Keep only boundary cells (2+ 동), each sorted DESC by 평균 (largest portion top).
      const gridBreakdown = {}
      for (const [c, arr] of Object.entries(byGrid)) {
        if (arr.length >= 2) gridBreakdown[c] = arr.sort((a, b) => b.평균 - a.평균)
      }
      set((s) => ({ data: { ...s.data, gridBreakdown } }))
    } catch {
      // Purely additive (tooltip extra) — a failure must NOT surface as a map error.
      if (myseq === _seq) set((s) => ({ data: { ...s.data, gridBreakdown: {} } }))
    }
  },

  // ── Day-mode local recompute (hour filter, NO network) ─────────────────────
  // In day mode the backend already returned the FULL 24h × area series (cached in
  // data.dayseries). Re-derive 평균 생활인구 over the currently-selected hours WITHOUT
  // a refetch, so the 시간대 slider updates KPI + map instantly. Touches ONLY
  // values/valuesByCode — never loading/error/dayseries (no request lifecycle here),
  // so it stays outside the _seq race guard (a pure local transform of cached data).
  _recomputeDay: () => {
    const { values, byCode } = dayAverages(
      get().data.dayseries ?? [],
      get().selection.hours,
    )
    set((s) => ({ data: { ...s.data, values, valuesByCode: byCode } }))
  },

  // ── Inspect (우클릭 → 한 단계 아래 분포) ───────────────────────────────────────
  // inspectArea: open the right-panel analysis for a right-clicked area. Sets `target`
  // synchronously (panel shows a spinner), then refetchInspect does the level-specific
  // fetch. The actual analysis depends on the clicked level (see the state comment).
  inspectArea: (level, code, name) => {
    const c = code == null ? '' : String(code).trim()
    if (!c) return // nothing to inspect without a code
    set((s) => ({
      data: {
        ...s.data,
        inspect: {
          ...s.data.inspect,
          target: { level, code: c, name: name ?? c },
          loading: true,
          error: null,
        },
      },
    }))
    get().refetchInspect()
  },

  // refetchInspect: (re)fetch the current inspect target's distribution — mode-/filter-
  // aware (called by the filter setters via _scheduleFetch). Race-guarded by
  // `_seqInspect`; no-op when no target; NEVER throws.
  refetchInspect: async () => {
    const t = get().data.inspect.target
    if (!t) return
    const myI = ++_seqInspect
    const sel = get().selection
    set((s) => ({
      data: { ...s.data, inspect: { ...s.data.inspect, loading: true, error: null } },
    }))
    try {
      if (t.level === 'grid') {
        // 격자 우클릭 → 그 격자의 시계열 추이 (기존 추이 로직).
        const resp = await postTrend({
          level: 'grid', code: t.code, mode: sel.mode,
          sex: sel.sex, ages: sel.ages, hours: sel.hours, weekday: sel.weekday,
        })
        if (myI !== _seqInspect) return
        set((s) => ({
          data: { ...s.data, inspect: { ...s.data.inspect,
            trend: {
              mode: resp?.mode ?? sel.mode,
              points: resp?.points ?? [],
              recent30: resp?.recent30 ?? [],
              sameWeekday: resp?.sameWeekday ?? [],
            },
            loading: false, error: null } } }))
      } else if (t.level === 'dong') {
        // 동 우클릭 → 그 동의 격자 평균을 **구 전체 격자 스케일**로 묶은 파이. 동 자체
        // 값으로 분위 스케일을 만들면 분위 정의상 항상 균등(모든 동이 동일) → 무의미.
        // 그래서 구 전체 격자값(scaleValues)으로 분위 경계를 잡고 그 동 값만 binning.
        const guCode = t.code.slice(0, 5)
        const [dong, gu] = await Promise.all([
          _fetchScopeValues({ ...sel, level: 'grid', gu: guCode, dong: t.code }),
          _fetchScopeValues({ ...sel, level: 'grid', gu: guCode, dong: null }),
        ])
        if (myI !== _seqInspect) return
        set((s) => ({
          data: { ...s.data, inspect: { ...s.data.inspect,
            gridDist: { values: dong.values, scaleValues: gu.values },
            loading: false, error: null } } }))
      } else {
        // 구 우클릭 → 행정동별 평균(비교)만. 전체 구 추이는 상시 패널(fetchAllGuTrend)로 분리.
        const [dongVals, dongMeta] = await Promise.all([
          _fetchScopeValues({ ...sel, level: 'dong', gu: t.code, dong: null }),
          getDongs(t.code),
        ])
        if (myI !== _seqInspect) return
        set((s) => ({
          data: { ...s.data, inspect: { ...s.data.inspect,
            dongCompare: { byCode: dongVals.byCode, values: dongVals.values, dongs: dongMeta ?? [] },
            loading: false, error: null } } }))
      }
    } catch (e) {
      if (myI !== _seqInspect) return // stale failure: a newer request/close owns it
      set((s) => ({
        data: { ...s.data, inspect: { ...s.data.inspect, loading: false, error: String(e?.message ?? e) } } }))
    }
  },

  // fetchAllGuTrend: load the 전체 구 추이 overview (ALWAYS shown in the panel). Tracks
  // the current mode/filters (called on init + via _scheduleFetch). Derives 평균 per
  // (구, 라벨) = 합계/(일수×시간수); day 는 일수=1. Race-guarded by `_seqAllGu`; never throws.
  fetchAllGuTrend: async () => {
    const sel = get().selection
    const myG = ++_seqAllGu
    set((s) => ({ data: { ...s.data, allGuTrend: { ...s.data.allGuTrend, loading: true, error: null } } }))
    try {
      const ag = await postTrendAllGu({
        mode: sel.mode, hours: sel.hours, weekday: sel.weekday, sex: sel.sex, ages: sel.ages,
      })
      if (myG !== _seqAllGu) return
      const 시간수 = hourCount(sel.hours)
      const byGu = {}
      for (const r of ag.rows ?? []) {
        const days = ag.mode === 'day' ? 1 : (ag.일수?.[r.라벨] ?? 0)
        const 평균 =
          days > 0 && 시간수 > 0 && Number.isFinite(r.합계) ? r.합계 / (days * 시간수) : null
        ;(byGu[String(r.구)] ??= []).push({ 라벨: String(r.라벨), 평균 })
      }
      const names = {}
      for (const d of get().data.districts ?? []) names[String(d.구코드)] = d.구명
      set((s) => ({ data: { ...s.data, allGuTrend: { mode: ag.mode, byGu, names, loading: false, error: null } } }))
    } catch (e) {
      if (myG !== _seqAllGu) return
      set((s) => ({ data: { ...s.data, allGuTrend: { ...s.data.allGuTrend, loading: false, error: String(e?.message ?? e) } } }))
    }
  },

  // closeInspect: hide the inspect panel + bump `_seqInspect` so an in-flight fetch
  // can't repopulate it.
  closeInspect: () => {
    ++_seqInspect
    set((s) => ({
      data: { ...s.data, inspect: { ...s.data.inspect, target: null, loading: false, error: null } } }))
  },

  // ── Multi-gu grid view (여러 구 격자 비교) ─────────────────────────────────────
  // setMultiGridGus: pick the set of 구 whose grids are shown together.
  //   empty → EXIT the view (clear multiGrid, bump `_seqMulti` so an in-flight load
  //           can't repopulate it). The map returns to the normal level rendering.
  //   else  → store the gus + loading:true, then refetchMultiGrid() to fetch every
  //           gu's grid geo + values IN PARALLEL and MERGE them.
  // Multi-grid + compare are mutually exclusive: entering multi-grid turns compare OFF
  // (its swipe split has no meaning over a merged multi-gu choropleth). Codes are
  // de-duped + trimmed defensively so a stray duplicate/blank never doubles a request.
  setMultiGridGus: (guCodes) => {
    const gus = Array.from(
      new Set(
        (Array.isArray(guCodes) ? guCodes : [])
          .map((g) => (g == null ? '' : String(g).trim()))
          .filter(Boolean),
      ),
    )
    if (gus.length === 0) {
      ++_seqMulti // invalidate any in-flight multi load → it won't write back
      set((s) => ({
        data: {
          ...s.data,
          multiGrid: { gus: [], geo: null, values: {}, valuesByCode: {}, breakdown: {}, loading: false, error: null },
        },
      }))
      return
    }
    // Entering (or changing) the multi-grid view: turn compare off so the two views
    // never coexist. Tear down B's debounce + data the same way toggleCompare(OFF) does.
    if (get().compareMode) {
      if (_debounceTimerB) {
        clearTimeout(_debounceTimerB)
        _debounceTimerB = null
      }
      set((s) => ({
        compareMode: false,
        selectionB: null,
        data: { ...s.data, valuesB: {}, valuesByCodeB: {} },
      }))
    }
    set((s) => ({
      data: {
        ...s.data,
        multiGrid: {
          geo: null,
          values: {},
          valuesByCode: {},
          ...s.data.multiGrid,
          gus,
          loading: true,
          error: null,
        },
      },
    }))
    get().refetchMultiGrid()
  },

  // ── Multi-gu grid fetch + merge ──────────────────────────────────────────────
  // For each selected 구: fetch its grid geo (getGeo('grid',{gu})) + its grid values
  // (postQuery/postDay at level:'grid', gu-scope) IN PARALLEL (Promise.all over the
  // gus, each gu doing its own geo+query). Then MERGE:
  //   geo          — concat every gu's grid features into one FeatureCollection
  //   values/byCode — derive each gu's 평균 via the SAME path as fetchAll
  //                   (day→dayAverages, else→monthWeekAverages) using the CURRENT
  //                   A-side filters + hourCount, then spread-merge the maps.
  // Uses the shared A-side filters (sex/ages/hours/weekday/period/mode) so the multi
  // view tracks the same controls as the normal map. Race-guarded by `_seqMulti`;
  // NEVER throws (an error sets multiGrid.error + clears loading). Re-callable: the
  // filter setters call this when multiGrid is active so a filter change recolors the
  // merged grids. N (selected 구) is small, so N parallel geo+query pairs is fine.
  refetchMultiGrid: async () => {
    const gus = get().data.multiGrid?.gus
    if (!gus || gus.length === 0) return
    const sel = get().selection
    const myM = ++_seqMulti
    set((s) => ({
      data: { ...s.data, multiGrid: { ...s.data.multiGrid, loading: true, error: null } },
    }))
    try {
      // Per-gu: geo + (day|month/week) values, derived to a {code:평균}+byCode map.
      const perGu = await Promise.all(
        gus.map(async (gu) => {
          const q = {
            level: 'grid',
            gu,
            dong: null,
            mode: sel.mode,
            period: sel.period,
            hours: sel.hours,
            weekday: sel.weekday,
            sex: sel.sex,
            ages: sel.ages,
          }
          if (sel.mode === 'day') {
            const [geo, resp] = await Promise.all([
              getGeo('grid', { gu }),
              postDay(q),
            ])
            const { values, byCode } = dayAverages(resp.series ?? [], sel.hours)
            return { gu, geo, values, byCode }
          }
          const [geo, resp] = await Promise.all([
            getGeo('grid', { gu }),
            postQuery(q),
          ])
          const { valuesByCode: vbc } = featuresToValues(resp.features)
          const { values, byCode } = monthWeekAverages(
            vbc,
            resp.일수,
            hourCount(sel.hours),
          )
          return { gu, geo, values, byCode }
        }),
      )
      if (myM !== _seqMulti) return // a newer gu-set / filter / exit superseded this
      // MERGE across 구. A boundary 격자 overlaps 2+ 구, so EACH 구's query returns it
      // with THAT 구's portion (평균), and each 구's geo returns the same boundary cell.
      // So we:
      //   · DEDUPE the geometry by 격자코드 (keep one cell — the union has it 2+ times),
      //   · SUM the per-구 portion 평균 per 격자코드 (boundary cell painted with its TOTAL),
      //   · record a per-구 BREAKDOWN [{구, 구명, 평균}] so the tooltip shows total + split.
      const guName = {}
      for (const d of get().data.districts ?? []) guName[String(d.구코드)] = d.구명
      const seen = new Set()
      const features = []
      const values = {}
      const valuesByCode = {}
      const breakdown = {}
      for (const r of perGu) {
        for (const f of r.geo?.features ?? []) {
          const c = String(f?.properties?.['격자코드'] ?? '').trim()
          if (!c || seen.has(c)) continue
          seen.add(c)
          features.push(f)
        }
        for (const [c, v] of Object.entries(r.values)) {
          if (Number.isFinite(v)) values[c] = (values[c] ?? 0) + v
        }
        for (const [c, rec] of Object.entries(r.byCode)) {
          const avg = rec?.평균
          if (!Number.isFinite(avg)) continue
          const prev = valuesByCode[c]
          if (!prev) {
            valuesByCode[c] = { ...rec } // first 구: keep the full record {합계,일평균,평균}
          } else {
            // overlap: sum each numeric field (일평균 null if either side is null/day-mode)
            const both = (a, b) =>
              Number.isFinite(a) && Number.isFinite(b) ? a + b : null
            valuesByCode[c] = {
              합계: (prev.합계 ?? 0) + (rec.합계 ?? 0),
              일평균: both(prev.일평균, rec.일평균),
              평균: (prev.평균 ?? 0) + avg,
            }
          }
          ;(breakdown[c] ??= []).push({
            구: r.gu,
            구명: guName[String(r.gu)] ?? String(r.gu),
            평균: avg,
          })
        }
      }
      const geo = { type: 'FeatureCollection', features }
      set((s) => ({
        data: {
          ...s.data,
          multiGrid: { ...s.data.multiGrid, geo, values, valuesByCode, breakdown, loading: false, error: null },
        },
      }))
    } catch (e) {
      if (myM !== _seqMulti) return // stale failure: a newer request/exit owns it
      set((s) => ({
        data: {
          ...s.data,
          multiGrid: { ...s.data.multiGrid, loading: false, error: String(e?.message ?? e) },
        },
      }))
    }
  },

  // ── App-mount initialization ───────────────────────────────────────────────
  // Idempotent: React 19 StrictMode double-invokes the mount effect in dev, so a
  // guard prevents a duplicate initial network burst.
  init: async () => {
    if (get()._initialized || get().data.range) return
    _cancelScheduledFetch()
    set({ _initialized: true })

    // 1) health precheck — non-fatal, still attempt the loads below.
    try {
      const h = await getHealth()
      set((s) => ({ data: { ...s.data, healthy: !!h?.ok } }))
    } catch {
      set((s) => ({
        data: { ...s.data, healthy: false, error: '백엔드(9601) 연결 실패' },
      }))
    }

    // 2) parallel base loads (range + districts meta + districts geo).
    try {
      const [range, districts, districtsGeo] = await Promise.all([
        getRange(),
        getDistricts(),
        getGeo('gu'),
      ])
      set((s) => ({ data: { ...s.data, range, districts, districtsGeo } }))
      // Verification logs (double as the Task 3 gate). Dev-only — not shipped.
      if (import.meta.env.DEV) {
        console.log('[init] districts:', districts.length)
        console.log(
          '[init] districtsGeo features:',
          districtsGeo?.features?.length,
        )
      }
    } catch (e) {
      get().setError(e)
    }

    // 3) initial choropleth values for the default selection (gu/month/202506).
    await get().fetchAll()
    // 4) 전체 구 추이 overview (always shown in the panel) — fire-and-forget.
    get().fetchAllGuTrend()
    if (import.meta.env.DEV) {
      console.log('[init] values codes:', Object.keys(get().data.values).length)
    }
  },
}))

// Dev-only test visibility: expose the store on window so Playwright/manual checks
// can read selection/data live. Gated behind DEV — never shipped to production.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__store = useStore
}

export default useStore
