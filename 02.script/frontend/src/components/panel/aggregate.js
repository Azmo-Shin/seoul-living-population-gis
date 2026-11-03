// Pure aggregation + formatting helpers for the KPI/chart panel (Task 7).
//
// These are deliberately separated from the Plotly/React components so they are
// unit-testable in a node environment (no DOM). They read plain data shapes that
// mirror the store: `valuesByCode` ({ [code]: {합계, 일평균, 평균} }), `일수` (int),
// `dayseries` ([{시간, code, 값}]), and the name-lookup metas (districts/dongs).
//
// Headline metric: 평균 생활인구 — the AVERAGE number of people present during the
// selected day×hour window (NOT the person-hours 합계). month/week: 합계/(일수×시간수);
// day: (Σ over selected hours of 값)/시간수. See monthWeekAverages / dayAverages.

// ── Compact ko-KR big-number formatter ───────────────────────────────────────
// Korean readers parse large counts in 억(10^8) / 만(10^4) units. We abbreviate
// to ONE of those with a single decimal so KPI numbers stay scannable, e.g.
//   203,285,978 → "2.03억"   6,776,199 → "677.6만"   8,500 → "8,500"
// Returns a string. The FULL value (toLocaleString) is exposed separately via
// `fullNumber` for a title/tooltip so precision is never lost.
const EOK = 100000000 // 억
const MAN = 10000 // 만

export function fmtCompactKo(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  const abs = Math.abs(v)
  if (abs >= EOK) {
    // 2 significant decimals on 억 reads well for population magnitudes.
    return `${trimZero(v / EOK, 2)}억`
  }
  if (abs >= MAN) {
    return `${trimZero(v / MAN, 1)}만`
  }
  return Math.round(v).toLocaleString('ko-KR')
}

// Round to `d` decimals and drop a trailing ".0"/".00" so "2.00억" → "2억".
function trimZero(x, d) {
  const r = Number(x.toFixed(d))
  return r.toLocaleString('ko-KR', { maximumFractionDigits: d })
}

// Full ko-KR value (thousands separators), rounded — for the tooltip/title.
export function fullNumber(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—'
  return Math.round(Number(n)).toLocaleString('ko-KR')
}

// ── Selected-hour count ──────────────────────────────────────────────────────
// The headline metric is 평균 생활인구 = the average people PRESENT during the
// selected day×hour window. The denominator includes the number of SELECTED hours.
// An empty/nullish `hours` selection means "all hours" → 24. Duplicates are de-
// duped via a Set; only valid integer hours in 0..23 count.
//
// @param {number[]|null|undefined} hours
// @returns {number} distinct valid selected hours (24 when empty/nullish)
export function hourCount(hours) {
  if (hours == null || hours.length === 0) return 24
  const set = new Set()
  for (const h of hours) {
    const n = Number(h)
    if (Number.isInteger(n) && n >= 0 && n <= 23) set.add(n)
  }
  // An array of only-invalid hours collapses to 0 distinct → treat as "all" (24)
  // so the denominator is never 0 (avoids a divide-by-zero in the averages).
  return set.size === 0 ? 24 : set.size
}

// ── Month/week averages (평균 생활인구) ───────────────────────────────────────
// Convert the backend's person-hours 합계 into a real average population: the
// average number of people present during the selected day×hour window.
//
//   평균_code = 합계_code / (일수 × 시간수)
//
// where 일수 = resp.일수 (days in the period) and 시간수 = number of selected hours
// (= hourCount(selection.hours)). This is a monotonic transform of 일평균 within a
// single query (평균 = 일평균/시간수), so the choropleth RANKING/colors are identical
// — only the DISPLAYED numbers become real populations.
//
// Fallback: when 평균 can't be computed (e.g. 일수 missing/0 or 시간수 0), `values`
// falls back to `일평균 ?? 합계` so the map never goes fully blank, and `total` sums
// that same fallback. `byCode` always carries {합계, 일평균, 평균} (평균 = null when
// it couldn't be derived) — 합계/일평균 are kept internally (harmless) but not shown.
// CAVEAT: this fallback is a last-resort "never go fully blank" value, NOT the
// spec-correct average. It is only reached on backend 일수 anomalies (null/0), and
// can be unit-heterogeneous across features (some 일평균, some raw 합계). The happy
// path (일수 present) never hits it.
//
// @param {Record<string,{합계:number, 일평균:number|null}>} valuesByCode
// @param {number|null} 일수
// @param {number} 시간수
// @returns {{values:Record<string,number>, byCode:Record<string,{합계:number,일평균:number|null,평균:number|null}>, total:number}}
export function monthWeekAverages(valuesByCode, 일수, 시간수) {
  const values = {}
  const byCode = {}
  let total = 0
  const days = Number(일수)
  const hrs = Number(시간수)
  const canAvg = Number.isFinite(days) && days > 0 && Number.isFinite(hrs) && hrs > 0
  for (const [code, rec] of Object.entries(valuesByCode ?? {})) {
    const 합계 = rec?.합계 ?? null
    const 일평균 = rec?.일평균 ?? null
    // Guard the nullish 합계 EXPLICITLY: Number(null) === 0 (finite), which would
    // otherwise compute a spurious 평균 of 0 for a feature that has no 합계 at all.
    const s = 합계 === null ? NaN : Number(합계)
    let 평균 = null
    if (canAvg && Number.isFinite(s)) {
      평균 = s / (days * hrs)
    }
    byCode[code] = { 합계, 일평균, 평균 }
    // value for the map: 평균 when finite, else the documented fallback (일평균 ?? 합계).
    let v
    if (평균 !== null && Number.isFinite(평균)) {
      v = 평균
    } else {
      // Guard the nullish fallback EXPLICITLY before Number(): Number(null) === 0
      // (finite), which would otherwise inject a spurious 0 for a missing feature.
      const fb = 일평균 ?? 합계
      v = fb !== null && fb !== undefined && Number.isFinite(Number(fb)) ? Number(fb) : null
    }
    if (v !== null && Number.isFinite(v)) {
      values[code] = v
      total += v
    }
  }
  return { values, byCode, total }
}

// ── Day averages (평균 생활인구, single date) ─────────────────────────────────
// In day mode the backend returns the FULL 24h × area series. The headline is the
// average population over the SELECTED hours of that one day:
//
//   평균_code = (Σ over selected hours of 값_code) / 시간수
//
// 시간수 = hourCount(hours). This is a pure local recompute, so changing the 시간대
// filter in day mode re-derives values WITHOUT a network refetch (the store calls
// this from _recomputeDay).
//
// @param {Array<{시간:number, code:string, 값:number}>} dayseries
// @param {number[]|null|undefined} hours  selected hours (empty/nullish = all 24)
// @returns {{values:Record<string,number>, byCode:Record<string,{평균:number}>, total:number, 시간수:number}}
export function dayAverages(dayseries, hours) {
  const 시간수 = hourCount(hours)
  // Build the set of selected hours (empty/nullish selection = all 24).
  const selected =
    hours == null || hours.length === 0
      ? null // null = accept every hour
      : new Set(
          hours
            .map((h) => Number(h))
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23),
        )
  const sums = {}
  for (const p of dayseries ?? []) {
    const h = Number(p?.시간)
    if (!Number.isInteger(h) || h < 0 || h > 23) continue
    if (selected && !selected.has(h)) continue
    const v = Number(p?.값)
    if (!Number.isFinite(v)) continue
    const code = p?.code
    sums[code] = (sums[code] ?? 0) + v
  }
  const values = {}
  const byCode = {}
  let total = 0
  for (const [code, sum] of Object.entries(sums)) {
    const 평균 = sum / 시간수
    values[code] = 평균
    byCode[code] = { 평균 }
    total += 평균
  }
  return { values, byCode, total, 시간수 }
}

// ── KPI scope average total (평균 생활인구, all modes) ─────────────────────────
// The headline KPI = Σ over codes of valuesByCode[code].평균 — the average scope
// population over the selected day×hour window. Skips non-finite/null 평균 cleanly.
//
// @param {Record<string,{평균?:number|null}>} valuesByCode
// @returns {{total:number, hasData:boolean}}
export function averageTotal(valuesByCode) {
  const entries = Object.values(valuesByCode ?? {})
  if (entries.length === 0) return { total: 0, hasData: false }
  let total = 0
  for (const e of entries) {
    const a = Number(e?.평균)
    if (Number.isFinite(a)) total += a
  }
  return { total, hasData: true }
}

// ── Name lookup (code → display label per level) ─────────────────────────────
// gu→구명 (districts), dong→행정동명 (dongs), grid→격자코드 itself (no name).
// Returns a Map(code → name) for the level; grids resolve to their own code.
//
// @param {'gu'|'dong'|'grid'} level
// @param {Array<{구코드:string,구명:string}>} districts
// @param {Array<{행정동코드:string,행정동명:string}>} dongs
export function buildNameLookup(level, districts = [], dongs = []) {
  const map = new Map()
  if (level === 'gu') {
    for (const d of districts) map.set(trim(d?.구코드), d?.구명 ?? trim(d?.구코드))
  } else if (level === 'dong') {
    for (const d of dongs)
      map.set(trim(d?.행정동코드), d?.행정동명 ?? trim(d?.행정동코드))
  }
  // grid → no meta; caller falls back to the code itself.
  return map
}

const trim = (v) => (v == null ? '' : String(v).trim())

// ── CompareBar data (current level's features, sorted, top-N) ────────────────
// Build [{name, value, code}] from valuesByCode where value = the displayed metric
// (평균 ?? 일평균 ?? 합계, matching the map's 평균 생활인구), name = display label per
// level. Sorts DESC by value and truncates to topN (grids can be hundreds). Returns
// the truncation flag + total count so the chart can annotate "상위 N".
//
// @param {Record<string,{합계?:number, 일평균?:number|null, 평균?:number|null}>} valuesByCode
// @param {'gu'|'dong'|'grid'} level
// @param {{districts?:Array, dongs?:Array, topN?:number}} opts
// @returns {{rows:Array<{name:string,value:number,code:string}>, total:number, truncated:boolean}}
export function compareBarData(valuesByCode, level, opts = {}) {
  const { districts = [], dongs = [], topN = 15 } = opts
  const names = buildNameLookup(level, districts, dongs)
  const rows = []
  for (const [code, rec] of Object.entries(valuesByCode ?? {})) {
    const value = rec?.평균 ?? rec?.일평균 ?? rec?.합계
    if (value === null || value === undefined || !Number.isFinite(Number(value)))
      continue
    rows.push({
      code,
      name: names.get(trim(code)) ?? trim(code), // grid → its own code
      value: Number(value),
    })
  }
  rows.sort((a, b) => b.value - a.value)
  const total = rows.length
  const truncated = total > topN
  return { rows: truncated ? rows.slice(0, topN) : rows, total, truncated }
}

// ── Trend averages (월/주 평균 생활인구) ──────────────────────────────────────
// Convert the backend's per-라벨 person-hours 합계 into a real average population for
// each label (month 연월 OR week 연주 — both share the {라벨, 합계, 일수} point shape),
// mirroring monthWeekAverages over the trend points:
//
//   평균_라벨 = 합계_라벨 / (일수_라벨 × 시간수)
//
// 일수 is per-point (the period's loaded days, weekday-filtered) and 시간수 is the
// CURRENT 시간대 selection (= hourCount(selection.hours), passed in). A point whose
// 평균 can't be derived (일수 missing/≤0 or 시간수 ≤0, or a non-finite 합계) carries
// 평균:null — the chart simply skips it (a gap), so a bad period never plots a 0 or
// NaN. Input order is preserved (the backend returns 라벨 ascending). Accepts a legacy
// `연월` key as a fallback so older callers/fixtures keep working.
//
// @param {Array<{라벨:string, 합계:number, 일수:number|null}>} points
// @param {number} 시간수  selected-hour count (hourCount(selection.hours))
// @returns {Array<{라벨:string, 평균:number|null}>}
export function trendAverages(points, 시간수) {
  const hrs = Number(시간수)
  const hrsOk = Number.isFinite(hrs) && hrs > 0
  const out = []
  for (const p of points ?? []) {
    const 라벨 = p?.라벨 ?? p?.연월
    if (라벨 == null) continue
    const days = Number(p?.일수)
    const 합계 = p?.합계
    // Guard nullish 합계 explicitly (Number(null) === 0 would plot a spurious 0).
    const s = 합계 === null || 합계 === undefined ? NaN : Number(합계)
    let 평균 = null
    if (hrsOk && Number.isFinite(days) && days > 0 && Number.isFinite(s)) {
      평균 = s / (days * hrs)
    }
    out.push({ 라벨: String(라벨), 평균 })
  }
  return out
}

// ── Day-trend averages (일별 평균 = 합계 / 시간수) ─────────────────────────────
// day-mode trend series (recent30 / sameWeekday) carry ONE point per 일자 whose 합계
// is the person-hours over the selected hours of that SINGLE day (일수=1 fixed). So:
//
//   평균_일 = 합계_일 / 시간수
//
// 시간수 = the CURRENT 시간대 selection (hourCount(selection.hours)). A point whose
// 평균 can't be derived (시간수 ≤0 or non-finite 합계) carries 평균:null (chart gap).
// Input order is preserved (the backend returns 일자 ascending).
//
// @param {Array<{일자:string, 합계:number}>} series
// @param {number} 시간수  selected-hour count
// @returns {Array<{일자:string, 평균:number|null}>}
export function dayTrendAverages(series, 시간수) {
  const hrs = Number(시간수)
  const hrsOk = Number.isFinite(hrs) && hrs > 0
  const out = []
  for (const p of series ?? []) {
    const 일자 = p?.일자
    if (일자 == null) continue
    const 합계 = p?.합계
    const s = 합계 === null || 합계 === undefined ? NaN : Number(합계)
    let 평균 = null
    if (hrsOk && Number.isFinite(s)) 평균 = s / hrs
    out.push({ 일자: String(일자), 평균 })
  }
  return out
}

// ── Per-동 grid-cell bin distribution (A-2 gu-scope grid view) ───────────────
// For the whole-gu grid view, group the grid CELLS by their 행정동 and count how
// many cells fall in each of the color scale's value bins (the 6 Spectral 분위
// groups). This drives a per-동 stacked bar (counts/percentages by bin).
//
// Bin assignment MUST match the map/legend exactly, so we recompute the bin index
// from `scale.breaks` using the SAME rule as colorScale.binIndexFor:
//   v <= breaks[0]                  → bin 0
//   v >= breaks[last]               → bin (nBins-1)
//   breaks[i] <= v < breaks[i+1]    → bin i
// A grid with no usable value (null/NaN/not-in-values) is SKIPPED (it shows gray
// on the map and carries no 분위 meaning). 동 are keyed by 행정동코드 from
// `gridDong` ({ 격자코드: 행정동코드 }); a grid missing from gridDong is bucketed
// under a '' (no-동) key so it is never silently dropped from the totals.
//
// BOUNDARY CELLS (a 격자 straddling 2+ 동 within the 구) are SPLIT by 동 when
// `gridBreakdown` is supplied: each 동's portion is counted in THAT 동, binned by the
// portion's own 평균 (its share of the cell) — not the whole cell lumped onto one MAX
// 동. So a 동 that barely clips a cell gets a small (low-bin) count, and the cell's
// big-share 동 gets the high-bin count. Cells NOT in the breakdown (single-동, or no
// breakdown loaded / day mode) keep the whole-cell value on their gridDong 동 — so with
// no breakdown this is byte-for-byte the previous behavior.
//
// @param {Record<string,number>} values        { [격자코드]: 평균 } (cell totals)
// @param {Record<string,string>} gridDong       { [격자코드]: 행정동코드 } (single 동, MAX)
// @param {{breaks:number[], bins:Array, isEmpty:boolean}} scale  buildColorScale(values)
// @param {Map<string,string>|Record<string,string>} [dongNames]  행정동코드 → 행정동명
// @param {Record<string,Array<{행정동코드:string, 평균:number}>>} [gridBreakdown]
//   per-격자 동별 portions (only 2+ 동 cells); when present those cells are split.
// @returns {{rows:Array<{행정동코드:string, 행정동명:string, counts:number[], total:number}>, nBins:number}}
//   rows sorted DESC by total; counts[i] = #cell-portions of that 동 in bin i.
export function gridDongBinCounts(values, gridDong, scale, dongNames, gridBreakdown) {
  const breaks = scale?.breaks ?? []
  // nBins from the scale's bins (degenerate inputs collapse to <6); fall back to
  // breaks.length-1, then to 1, so we always allocate a valid counts array.
  const nBins = Math.max(
    1,
    Array.isArray(scale?.bins) && scale.bins.length > 0
      ? scale.bins.length
      : breaks.length > 1
        ? breaks.length - 1
        : 1,
  )

  // Bin index for a value, mirroring colorScale.binIndexFor over `breaks`.
  const binIndexFor = (v) => {
    if (breaks.length < 2) return 0 // single-bin / empty scale → everything in bin 0
    if (v <= breaks[0]) return 0
    if (v >= breaks[breaks.length - 1]) return nBins - 1
    for (let i = 0; i < nBins; i++) {
      if (v >= breaks[i] && v < breaks[i + 1]) return i
    }
    return nBins - 1
  }

  // name lookup accepts a Map or a plain object.
  const nameOf = (code) => {
    if (dongNames instanceof Map) return dongNames.get(code)
    if (dongNames && typeof dongNames === 'object') return dongNames[code]
    return undefined
  }

  const byDong = new Map() // 행정동코드 → { counts:number[], total }
  // Add ONE portion (a 동's share of a cell) to its bin. v = the portion's value.
  const bump = (dongCodeRaw, v) => {
    if (!Number.isFinite(v)) return // no usable value → skip (gray on map)
    const dongCode = dongCodeRaw == null ? '' : String(dongCodeRaw).trim()
    let rec = byDong.get(dongCode)
    if (!rec) {
      rec = { counts: new Array(nBins).fill(0), total: 0 }
      byDong.set(dongCode, rec)
    }
    rec.counts[binIndexFor(v)] += 1
    rec.total += 1
  }

  // 1) Boundary cells (2+ 동) → SPLIT: each 동's portion counted by its own 평균.
  const bd = gridBreakdown ?? {}
  const split = new Set()
  for (const [gridCode, parts] of Object.entries(bd)) {
    if (!Array.isArray(parts) || parts.length < 2) continue
    split.add(gridCode)
    for (const p of parts) bump(p?.행정동코드, Number(p?.평균))
  }
  // 2) Remaining cells (single 동) → whole-cell value on its gridDong 동.
  for (const [gridCode, dongCodeRaw] of Object.entries(gridDong ?? {})) {
    if (split.has(gridCode)) continue // already split above
    bump(dongCodeRaw, Number(values?.[gridCode]))
  }

  const rows = []
  for (const [행정동코드, rec] of byDong) {
    rows.push({
      행정동코드,
      행정동명: nameOf(행정동코드) ?? (행정동코드 || '정보 없음'),
      counts: rec.counts,
      total: rec.total,
    })
  }
  // DESC by total so the densest 동 sits at the top of the stacked-bar chart.
  rows.sort((a, b) => b.total - a.total)
  return { rows, nBins }
}

// Convert a gridDongBinCounts row's counts to PERCENTAGES of that 동's total (a
// 100%-stacked view). Returns a fresh number[] (0 when total is 0 — never NaN).
//
// @param {{counts:number[], total:number}} row
// @returns {number[]} per-bin percentage (0..100), same length as row.counts
export function binCountsToPct(row) {
  const counts = row?.counts ?? []
  const total = Number(row?.total) || 0
  if (total <= 0) return counts.map(() => 0)
  return counts.map((c) => (Number(c) / total) * 100)
}

// ── HourlyLine data (24-hour series) ─────────────────────────────────────────
// Aggregate dayseries by 시간 (0..23): hourTotal[h] = Σ over codes 값. Always
// returns a dense 24-length array (missing hours → 0) so the x-axis is complete.
//
// @param {Array<{시간:number, code:string, 값:number}>} dayseries
// @returns {{hours:number[], totals:number[]}}
export function hourlySeries(dayseries) {
  const totals = new Array(24).fill(0)
  for (const p of dayseries ?? []) {
    const h = Number(p?.시간)
    const v = Number(p?.값)
    if (Number.isInteger(h) && h >= 0 && h <= 23 && Number.isFinite(v)) {
      totals[h] += v
    }
  }
  const hours = Array.from({ length: 24 }, (_, i) => i)
  return { hours, totals }
}
