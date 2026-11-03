// API client — thin HTTP wrapper over the GIS backend (proxied via Vite to :9601).
//
// Responsibility: build URLs/bodies and parse JSON. NOTHING else.
// No data transformation (e.g. features→{code:값}) lives here — that is the store's
// job (see useStore.js). Keep this file purely about HTTP.

/**
 * Shared fetch helper.
 * - Sets Content-Type: application/json for requests with a body.
 * - Throws Error (with HTTP status + backend `detail` when present) on non-2xx.
 * - Returns parsed JSON on success.
 */
async function request(path, { method = 'GET', body } = {}) {
  const opts = { method }
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(path, opts)
  if (!res.ok) {
    // Try to surface the backend's structured error (FastAPI `{detail: ...}`).
    let detail = ''
    try {
      const errJson = await res.json()
      detail = errJson?.detail ? ` - ${JSON.stringify(errJson.detail)}` : ''
    } catch {
      // Body wasn't JSON; status alone is the signal.
    }
    throw new Error(`${method} ${path} → ${res.status}${detail}`)
  }
  return res.json()
}

// ── Health (NOT under /api — see vite.config.js proxy) ───────────────────────
export const getHealth = () => request('/healthz')

// ── Meta ─────────────────────────────────────────────────────────────────────
export const getRange = () => request('/api/meta/range')
export const getDistricts = () => request('/api/meta/districts')
export const getDongs = (gu) =>
  request(`/api/meta/dongs?gu=${encodeURIComponent(gu)}`)

// ── Geometry (GeoJSON FeatureCollections) ────────────────────────────────────
/**
 * @param {'gu'|'dong'|'grid'} level
 * @param {{gu?: string, dong?: string}} scope
 *   - gu   → /api/geo/districts
 *   - dong → /api/geo/dongs (+ ?gu= when scope.gu)
 *   - grid → /api/geo/grids?dong= (preferred) or ?gu= (whole-gu, A-2)
 */
export function getGeo(level, scope = {}) {
  if (level === 'gu') {
    return request('/api/geo/districts')
  }
  if (level === 'dong') {
    const qs = scope.gu ? `?gu=${encodeURIComponent(scope.gu)}` : ''
    return request(`/api/geo/dongs${qs}`)
  }
  if (level === 'grid') {
    // dong takes priority over gu (matches backend); at least one is required.
    if (scope.dong) {
      return request(`/api/geo/grids?dong=${encodeURIComponent(scope.dong)}`)
    }
    if (scope.gu) {
      return request(`/api/geo/grids?gu=${encodeURIComponent(scope.gu)}`)
    }
    throw new Error('getGeo(grid) requires scope.dong or scope.gu')
  }
  throw new Error(`getGeo: unknown level "${level}"`)
}

// ── Query (aggregated metrics) ───────────────────────────────────────────────
/**
 * POST /api/query — month/week aggregation.
 * `selection.period` MUST already be in the backend form (month: "YYYYMM" no dash).
 */
export function postQuery(selection) {
  const { level, mode, period, gu, dong, hours, weekday, sex, ages } = selection
  return request('/api/query', {
    method: 'POST',
    body: { level, mode, period, gu, dong, hours, weekday, sex, ages },
  })
}

/**
 * POST /api/query/day — single-day 24h series.
 * `selection.period` MUST be "YYYY-MM-DD". No hours/weekday for the day endpoint.
 */
export function postDay(selection) {
  const { level, period, gu, dong, sex, ages } = selection
  return request('/api/query/day', {
    method: 'POST',
    body: { level, period, gu, dong, sex, ages },
  })
}

/**
 * POST /api/query/grid_breakdown — A-2 (구 전체) 격자 뷰의 경계셀을 행정동별 portion 으로
 * 분해. Returns { 일수, items: [{격자코드, 행정동코드, 합계}] }. The store derives 평균 =
 * 합계 / (일수 × 시간수) per portion. month/week only (gu-scope grid). Additive — the
 * choropleth value still comes from /api/query (the within-gu sum).
 */
export function postGridBreakdown({ gu, mode, period, hours, weekday, sex, ages }) {
  return request('/api/query/grid_breakdown', {
    method: 'POST',
    body: { gu, mode, period, hours, weekday, sex, ages },
  })
}

/**
 * POST /api/query/trend_all_gu — 25개 자치구 추이를 한 번에 (구별 비교 라인차트).
 * Returns { mode, 일수: {라벨:일수}, rows: [{구, 라벨, 합계}] }. The store groups rows by
 * 구 and derives 평균 = 합계 / (일수[라벨] × 시간수); day mode → 일수=1. mode/filters
 * mirror the active selection (월=구-월 요약마트, 주/일=구-일 요약마트로 빠름).
 */
export function postTrendAllGu({ mode, hours, weekday, sex, ages }) {
  return request('/api/query/trend_all_gu', {
    method: 'POST',
    body: { mode, hours, weekday, sex, ages },
  })
}

/**
 * POST /api/query/trend — single-area trend, time-axis varies by `mode`:
 *   month → { …, mode:'month', points:[{ 라벨:"YYYYMM", 합계, 일수 }, …] }  (전체 기간)
 *   week  → { …, mode:'week',  points:[{ 라벨:"YYYY-WW", 합계, 일수 }, …] }  (최근 ~12주)
 *   day   → { …, mode:'day',   recent30:[{ 일자, 합계 }], sameWeekday:[{ 일자, 합계 }] }
 * The store derives 평균: month/week = 합계 / (일수 × 시간수); day = 합계 / 시간수 (일수=1).
 * `code` is the area's own code at `level` (구코드 / 행정동코드 / 격자코드). `mode`
 * mirrors the active 모드 so the trend's time axis matches the map; the CURRENT A-side
 * filters (성별/연령/시간대/요일) are baked into the returned 합계.
 */
export function postTrend({ level, code, mode, sex, ages, hours, weekday }) {
  return request('/api/query/trend', {
    method: 'POST',
    body: { level, code, mode, sex, ages, hours, weekday },
  })
}
