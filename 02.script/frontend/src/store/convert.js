// Pure conversion helpers for /api/query responses.
//
// This is the ONE fixed location where the backend's `features` array is reshaped
// into the lookup maps the UI consumes. Kept pure (no store/React) so it is unit
// testable and reusable.

/**
 * Convert a /api/query `features` array into the store's per-code lookup map.
 *
 * @param {Array<{code: string, 합계: number, 일평균: number|null}>} features
 * @returns {{ valuesByCode: Record<string, {합계: number, 일평균: number|null}> }}
 *
 * - `valuesByCode[code] = {합계, 일평균}` — full per-code record for tooltips/KPI.
 *   `합계` is the backend's person-hours sum; `일평균` the daily average (null only
 *   when 일수 is unavailable).
 *
 * The displayed color metric (평균 생활인구) is NOT computed here: the store derives it
 * later via `monthWeekAverages(valuesByCode, 일수, 시간수)`, which needs 일수/시간수 that
 * live outside a single feature record.
 */
export function featuresToValues(features = []) {
  const valuesByCode = {}
  for (const f of features) {
    // Join contract: keyed by f.code, which the backend /api/query already strips
    // (str(r["code"]).strip()) → keys arrive pre-trimmed; the map side trims geo
    // props defensively. A future backend strip change MUST keep this invariant.
    valuesByCode[f.code] = { 합계: f.합계, 일평균: f.일평균 }
  }
  return { valuesByCode }
}

/**
 * Build the per-grid → 행정동코드 membership map from a grid-level /api/query
 * `features` array. Each grid feature at level=grid carries 행정동코드 (the 동 that
 * cell belongs to); gu/dong features carry it as null/absent.
 *
 * @param {Array<{code: string, 행정동코드?: string|null}>} features
 * @returns {Record<string, string>} { [격자코드]: 행정동코드 }
 *
 * Only entries with BOTH a code and a non-empty 행정동코드 are included — a grid
 * missing its 동 (null/blank) is omitted (the consumer buckets unknowns itself).
 * Keys/values are trimmed defensively to mirror the join contract in
 * featuresToValues (codes arrive pre-stripped from the backend, but stay safe).
 * This drives the A-2 gu-scope per-동 grid distribution (gridDongBinCounts).
 */
export function featuresToGridDong(features = []) {
  const gridDong = {}
  for (const f of features) {
    const code = f?.code == null ? '' : String(f.code).trim()
    const 동 = f?.행정동코드 == null ? '' : String(f.행정동코드).trim()
    if (code && 동) gridDong[code] = 동
  }
  return gridDong
}
