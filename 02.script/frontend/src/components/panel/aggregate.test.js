// @vitest-environment node
//
// Pure-helper tests for the KPI/chart panel aggregation + formatting (Task 7).
// No DOM — these mirror the store data shapes exactly so the Plotly components can
// stay thin wrappers over verified math.
import { describe, it, expect } from 'vitest'
import {
  fmtCompactKo,
  fullNumber,
  hourCount,
  monthWeekAverages,
  dayAverages,
  averageTotal,
  buildNameLookup,
  compareBarData,
  hourlySeries,
  trendAverages,
  dayTrendAverages,
  gridDongBinCounts,
  binCountsToPct,
} from './aggregate.js'
import { buildColorScale } from '../../lib/colorScale.js'

describe('fmtCompactKo', () => {
  it('abbreviates 억 with 2 decimals', () => {
    expect(fmtCompactKo(203285978)).toBe('2.03억')
  })
  it('abbreviates 만 with 1 decimal', () => {
    expect(fmtCompactKo(6776199)).toBe('677.6만')
  })
  it('keeps thousands separators below 만', () => {
    expect(fmtCompactKo(8500)).toBe('8,500')
  })
  it('trims a trailing .0 (2.00억 → 2억)', () => {
    expect(fmtCompactKo(200000000)).toBe('2억')
    expect(fmtCompactKo(50000)).toBe('5만')
  })
  it('returns — for null / NaN', () => {
    expect(fmtCompactKo(null)).toBe('—')
    expect(fmtCompactKo(undefined)).toBe('—')
    expect(fmtCompactKo(NaN)).toBe('—')
  })
})

describe('fullNumber', () => {
  it('rounds + adds ko-KR thousands separators', () => {
    expect(fullNumber(203285978.4)).toBe('203,285,978')
  })
  it('returns — for nullish', () => {
    expect(fullNumber(null)).toBe('—')
  })
})

describe('hourCount', () => {
  it('returns 24 for empty / nullish (all hours)', () => {
    expect(hourCount([])).toBe(24)
    expect(hourCount(null)).toBe(24)
    expect(hourCount(undefined)).toBe(24)
  })
  it('counts distinct selected hours', () => {
    expect(hourCount([9, 10, 11, 12])).toBe(4)
    expect(hourCount([0])).toBe(1)
    // 9..18 inclusive = 10 hours
    expect(hourCount(Array.from({ length: 10 }, (_, i) => 9 + i))).toBe(10)
  })
  it('de-dupes duplicates via a Set', () => {
    expect(hourCount([9, 9, 10, 10, 10])).toBe(2)
  })
  it('ignores out-of-range / non-integer hours', () => {
    expect(hourCount([9, 24, -1, 10.5, 10])).toBe(2) // only 9 and 10 are valid
  })
  it('collapses an all-invalid selection to 24 (never 0)', () => {
    expect(hourCount([24, -1, 99])).toBe(24)
  })
})

describe('monthWeekAverages (평균 생활인구 = 합계/(일수×시간수))', () => {
  it('matches the verified 종로구 number: 203,285,978 / (30×24) ≈ 282,341', () => {
    const vbc = { 11110: { 합계: 203285978, 일평균: 6776199.27 } }
    const { values, byCode } = monthWeekAverages(vbc, 30, 24)
    // 203285978 / 720 = 282341.636… → the verified target is ~282,341 (±1).
    expect(values['11110']).toBeCloseTo(282341.64, 1)
    expect(Math.abs(values['11110'] - 282341) <= 1).toBe(true)
    expect(byCode['11110'].평균).toBeCloseTo(282341.64, 1)
    // 합계/일평균 are kept internally (harmless, not displayed).
    expect(byCode['11110'].합계).toBe(203285978)
    expect(byCode['11110'].일평균).toBe(6776199.27)
  })

  it('subset hours: 시간수 narrows the denominator', () => {
    // 9..18 = 10 hours → 합계/(30×10).
    const vbc = { 11110: { 합계: 203285978, 일평균: 6776199.27 } }
    const { values } = monthWeekAverages(vbc, 30, 10)
    expect(Math.round(values['11110'])).toBe(Math.round(203285978 / 300))
  })

  it('total = Σ 평균 over codes (scope average population)', () => {
    const vbc = {
      A: { 합계: 720, 일평균: 24 }, // 720/(30×24)=1
      B: { 합계: 1440, 일평균: 48 }, // 1440/(30×24)=2
    }
    const { values, total } = monthWeekAverages(vbc, 30, 24)
    expect(values.A).toBe(1)
    expect(values.B).toBe(2)
    expect(total).toBe(3)
  })

  it('null-일수 fallback: values fall back to 일평균 ?? 합계, 평균 is null', () => {
    const vbc = {
      A: { 합계: 100, 일평균: 10 },
      B: { 합계: 200, 일평균: null }, // no 일평균 → fall back to 합계
    }
    const { values, byCode, total } = monthWeekAverages(vbc, null, 24)
    expect(values.A).toBe(10) // 일평균
    expect(values.B).toBe(200) // 합계 fallback
    expect(byCode.A.평균).toBeNull()
    expect(byCode.B.평균).toBeNull()
    expect(total).toBe(210) // 10 + 200 (fallback sum)
  })

  it('시간수 0 also triggers the fallback (no divide-by-zero)', () => {
    const vbc = { A: { 합계: 100, 일평균: 10 } }
    const { values, byCode } = monthWeekAverages(vbc, 30, 0)
    expect(byCode.A.평균).toBeNull()
    expect(values.A).toBe(10) // 일평균 fallback
  })

  it('empty → empty maps, total 0', () => {
    const r = monthWeekAverages({}, 30, 24)
    expect(r.values).toEqual({})
    expect(r.byCode).toEqual({})
    expect(r.total).toBe(0)
  })

  it('skips non-finite 합계 without producing NaN', () => {
    const vbc = {
      A: { 합계: 720, 일평균: 24 },
      B: { 합계: null, 일평균: null },
    }
    const { values, total } = monthWeekAverages(vbc, 30, 24)
    expect(values.A).toBe(1)
    expect(values.B).toBeUndefined() // no usable value → omitted
    expect(total).toBe(1)
  })
})

describe('dayAverages (평균 = Σ over selected hours / 시간수)', () => {
  // Synthetic 24h × 1 code series: 값 = 시간+1 (so hour 0 → 1, …, hour 23 → 24).
  const full24 = Array.from({ length: 24 }, (_, h) => ({
    시간: h,
    code: 'X',
    값: h + 1,
  }))

  it('full 24h mean = sum/24', () => {
    const { values, byCode, total, 시간수 } = dayAverages(full24, [])
    // Σ(1..24) = 300; mean = 300/24 = 12.5
    expect(시간수).toBe(24)
    expect(values.X).toBe(12.5)
    expect(byCode.X.평균).toBe(12.5)
    expect(total).toBe(12.5)
  })

  it('subset hours: avg = (Σ over selected) / 시간수', () => {
    // hours 9..18 inclusive (10 hours). 값 at hour h = h+1 → 10..19.
    const hours = Array.from({ length: 10 }, (_, i) => 9 + i)
    const { values, 시간수 } = dayAverages(full24, hours)
    const expectedSum = hours.reduce((a, h) => a + (h + 1), 0) // Σ(10..19)=145
    expect(시간수).toBe(10)
    expect(values.X).toBe(expectedSum / 10) // 14.5
  })

  it('sums multiple codes independently', () => {
    const series = [
      { 시간: 0, code: 'A', 값: 10 },
      { 시간: 1, code: 'A', 값: 30 },
      { 시간: 0, code: 'B', 값: 100 },
    ]
    // all 24 hours selected → 시간수 24, but only 2 points contribute to A, 1 to B.
    const { values, total } = dayAverages(series, [])
    expect(values.A).toBe((10 + 30) / 24)
    expect(values.B).toBe(100 / 24)
    expect(total).toBeCloseTo((10 + 30 + 100) / 24, 9)
  })

  it('skips non-finite 값 and out-of-window hours', () => {
    const series = [
      { 시간: 9, code: 'X', 값: 100 },
      { 시간: 10, code: 'X', 값: null }, // non-finite → skipped
      { 시간: 20, code: 'X', 값: 999 }, // outside 9..10 window → skipped
    ]
    const { values, 시간수 } = dayAverages(series, [9, 10])
    expect(시간수).toBe(2)
    expect(values.X).toBe(100 / 2) // only the hour-9 point counts
  })

  it('empty dayseries → empty maps, total 0', () => {
    const r = dayAverages([], [9, 10])
    expect(r.values).toEqual({})
    expect(r.byCode).toEqual({})
    expect(r.total).toBe(0)
    expect(r.시간수).toBe(2)
  })
})

describe('averageTotal (scope-wide 평균 sum)', () => {
  it('sums 평균 across codes', () => {
    const vbc = { A: { 평균: 1.5 }, B: { 평균: 2.5 }, C: { 평균: 6 } }
    const r = averageTotal(vbc)
    expect(r.total).toBe(10)
    expect(r.hasData).toBe(true)
  })
  it('skips null / non-finite 평균', () => {
    const vbc = { A: { 평균: 5 }, B: { 평균: null }, C: { 평균: undefined } }
    expect(averageTotal(vbc).total).toBe(5)
  })
  it('empty → hasData:false, total 0', () => {
    expect(averageTotal({})).toEqual({ total: 0, hasData: false })
    expect(averageTotal(undefined)).toEqual({ total: 0, hasData: false })
  })
})

describe('buildNameLookup', () => {
  const districts = [
    { 구코드: '11110', 구명: '종로구' },
    { 구코드: '11140', 구명: '중구' },
  ]
  const dongs = [{ 행정동코드: '11110515', 행정동명: '청운효자동' }]

  it('gu → 구명', () => {
    const m = buildNameLookup('gu', districts, dongs)
    expect(m.get('11110')).toBe('종로구')
  })
  it('dong → 행정동명', () => {
    const m = buildNameLookup('dong', districts, dongs)
    expect(m.get('11110515')).toBe('청운효자동')
  })
  it('grid → empty map (caller falls back to the code)', () => {
    const m = buildNameLookup('grid', districts, dongs)
    expect(m.size).toBe(0)
  })
})

describe('compareBarData', () => {
  // Now keyed on 평균 (the new headline metric); 일평균/합계 only matter as fallbacks.
  const vbc = {
    '11110': { 합계: 1000, 일평균: 100, 평균: 10 },
    '11140': { 합계: 3000, 일평균: 300, 평균: 30 },
    '11170': { 합계: 2000, 일평균: 200, 평균: 20 },
  }
  const districts = [
    { 구코드: '11110', 구명: '종로구' },
    { 구코드: '11140', 구명: '중구' },
    { 구코드: '11170', 구명: '용산구' },
  ]

  it('sorts DESC by 평균 (the new metric) and maps names', () => {
    const { rows, total, truncated } = compareBarData(vbc, 'gu', { districts })
    expect(total).toBe(3)
    expect(truncated).toBe(false)
    expect(rows.map((r) => r.name)).toEqual(['중구', '용산구', '종로구'])
    expect(rows.map((r) => r.value)).toEqual([30, 20, 10]) // 평균, NOT 일평균/합계
  })

  it('uses 평균 over 일평균/합계 when present', () => {
    // 평균 wins even though 합계 would rank A first.
    const v = { A: { 합계: 9999, 일평균: 1, 평균: 1 }, B: { 합계: 1, 일평균: 9, 평균: 9 } }
    const { rows } = compareBarData(v, 'grid', {})
    expect(rows[0].code).toBe('B') // 평균 9 > 평균 1
    expect(rows[0].value).toBe(9)
  })

  it('falls back to 일평균 ?? 합계 when 평균 is null', () => {
    const v = { A: { 합계: 50, 일평균: null, 평균: null }, B: { 합계: 10, 일평균: 5, 평균: null } }
    const { rows } = compareBarData(v, 'grid', {})
    // A uses 합계 (50) > B uses 일평균 (5) → A first.
    expect(rows[0].code).toBe('A')
    expect(rows[0].value).toBe(50)
    expect(rows[1].value).toBe(5)
  })

  it('grid names fall back to the code itself', () => {
    const v = { gridX: { 평균: 9 } }
    const { rows } = compareBarData(v, 'grid', {})
    expect(rows[0].name).toBe('gridX')
  })

  it('truncates to topN and flags truncation', () => {
    const many = {}
    for (let i = 0; i < 40; i++) many[`g${i}`] = { 평균: i }
    const { rows, total, truncated } = compareBarData(many, 'grid', { topN: 15 })
    expect(total).toBe(40)
    expect(truncated).toBe(true)
    expect(rows.length).toBe(15)
    // DESC → top row is the largest (g39 = 39).
    expect(rows[0].value).toBe(39)
    expect(rows[14].value).toBe(25)
  })

  it('skips non-finite values without crashing', () => {
    const v = { A: { 합계: null, 일평균: null, 평균: null }, B: { 평균: 5 } }
    const { rows, total } = compareBarData(v, 'grid', {})
    expect(total).toBe(1)
    expect(rows[0].code).toBe('B')
  })

  it('empty → no rows, not truncated', () => {
    const { rows, total, truncated } = compareBarData({}, 'gu', { districts })
    expect(rows).toEqual([])
    expect(total).toBe(0)
    expect(truncated).toBe(false)
  })
})

describe('gridDongBinCounts (per-동 grid bin distribution, A-2)', () => {
  // 6 grid values 10,20,30,40,50,60 → 6-quantile breaks; each lands in its own bin
  // (ascending). gridDong groups them into two 동: A gets the low 3, B the high 3.
  const values = { g1: 10, g2: 20, g3: 30, g4: 40, g5: 50, g6: 60 }
  const gridDong = {
    g1: '11110510',
    g2: '11110510',
    g3: '11110510',
    g4: '11110520',
    g5: '11110520',
    g6: '11110520',
  }
  const dongNames = { 11110510: '가동', 11110520: '나동' }

  it('counts each 동’s grids per bin and resolves 행정동명', () => {
    const scale = buildColorScale(values)
    const { rows, nBins } = gridDongBinCounts(values, gridDong, scale, dongNames)
    expect(nBins).toBe(scale.bins.length) // 6 distinct → 6 bins
    expect(rows).toHaveLength(2)
    // Each 동 has 3 grids; bin assignment matches colorScale exactly.
    const byCode = Object.fromEntries(rows.map((r) => [r.행정동코드, r]))
    expect(byCode['11110510'].행정동명).toBe('가동')
    expect(byCode['11110520'].행정동명).toBe('나동')
    expect(byCode['11110510'].total).toBe(3)
    expect(byCode['11110520'].total).toBe(3)
    // Σ counts === total for every row.
    for (const r of rows) {
      expect(r.counts.reduce((a, c) => a + c, 0)).toBe(r.total)
      expect(r.counts).toHaveLength(nBins)
    }
    // A (low values) fills the LOW bins; B (high values) the HIGH bins.
    expect(byCode['11110510'].counts.slice(0, 3).reduce((a, c) => a + c, 0)).toBe(3)
    expect(byCode['11110520'].counts.slice(3).reduce((a, c) => a + c, 0)).toBe(3)
  })

  it('every grid’s bin matches colorScale.getColor’s bin (parity with the map)', () => {
    const scale = buildColorScale(values)
    const { rows, nBins } = gridDongBinCounts(values, gridDong, scale, dongNames)
    // Reconstruct the expected bin index per value via the scale’s OWN colors and
    // compare to where gridDongBinCounts placed each 동’s grids.
    const colorToBin = new Map(
      scale.bins.map((b, i) => [b.color.join(','), i]),
    )
    const expected = new Array(nBins).fill(0)
    const expectedByDong = { 11110510: [...expected], 11110520: [...expected] }
    for (const [g, dong] of Object.entries(gridDong)) {
      const bi = colorToBin.get(scale.getColor(values[g]).join(','))
      expectedByDong[dong] = expectedByDong[dong].map((c, i) => (i === bi ? c + 1 : c))
    }
    const byCode = Object.fromEntries(rows.map((r) => [r.행정동코드, r]))
    expect(byCode['11110510'].counts).toEqual(expectedByDong['11110510'])
    expect(byCode['11110520'].counts).toEqual(expectedByDong['11110520'])
  })

  it('sorts rows DESC by total (densest 동 first)', () => {
    const v = { g1: 1, g2: 2, g3: 3, g4: 4 }
    const gd = { g1: 'X', g2: 'X', g3: 'X', g4: 'Y' } // X:3, Y:1
    const scale = buildColorScale(v)
    const { rows } = gridDongBinCounts(v, gd, scale, { X: '엑스동', Y: '와이동' })
    expect(rows.map((r) => r.행정동코드)).toEqual(['X', 'Y'])
    expect(rows[0].total).toBe(3)
    expect(rows[1].total).toBe(1)
  })

  it('skips grids with no usable value (gray on the map)', () => {
    const v = { g1: 10, g2: 20 } // g3 has no value
    const gd = { g1: 'A', g2: 'A', g3: 'A' }
    const scale = buildColorScale(v)
    const { rows } = gridDongBinCounts(v, gd, scale, { A: '에이동' })
    expect(rows).toHaveLength(1)
    expect(rows[0].total).toBe(2) // g3 skipped
  })

  it('buckets grids missing a 동 under a placeholder (never dropped)', () => {
    const v = { g1: 10, g2: 20 }
    const gd = { g1: 'A', g2: '' } // g2 has no 동
    const scale = buildColorScale(v)
    const { rows } = gridDongBinCounts(v, gd, scale, { A: '에이동' })
    const noDong = rows.find((r) => r.행정동코드 === '')
    expect(noDong).toBeTruthy()
    expect(noDong.행정동명).toBe('정보 없음')
    expect(noDong.total).toBe(1)
  })

  it('accepts a Map for dongNames', () => {
    const v = { g1: 10, g2: 20 }
    const gd = { g1: 'A', g2: 'A' }
    const scale = buildColorScale(v)
    const names = new Map([['A', '맵동']])
    const { rows } = gridDongBinCounts(v, gd, scale, names)
    expect(rows[0].행정동명).toBe('맵동')
  })

  it('empty inputs → no rows', () => {
    const scale = buildColorScale({})
    const { rows } = gridDongBinCounts({}, {}, scale, {})
    expect(rows).toEqual([])
  })

  it('all-equal values (single bin) still counts without crashing', () => {
    const v = { g1: 5, g2: 5, g3: 5 }
    const gd = { g1: 'A', g2: 'A', g3: 'B' }
    const scale = buildColorScale(v) // degenerate → 1 bin
    const { rows, nBins } = gridDongBinCounts(v, gd, scale, { A: '에이', B: '비' })
    expect(nBins).toBe(1)
    const byCode = Object.fromEntries(rows.map((r) => [r.행정동코드, r]))
    expect(byCode.A.counts).toEqual([2])
    expect(byCode.B.counts).toEqual([1])
  })

  it('SPLITS a boundary 격자 into per-동 portions when gridBreakdown is given', () => {
    // 4 plain cells shape the scale; B is a boundary cell (total 100, top bin).
    const values = { c1: 10, c2: 20, c3: 30, c4: 40, B: 100 }
    const scale = buildColorScale(values)
    // gridDong attributes B to ONE 동 (D2, the MAX) — the old, lossy behavior.
    const gridDong = { c1: 'D1', c2: 'D1', c3: 'D2', c4: 'D2', B: 'D2' }
    // breakdown splits B: D1 holds the big share (95), D2 a tiny clip (5).
    const gridBreakdown = {
      B: [
        { 행정동코드: 'D1', 평균: 95 },
        { 행정동코드: 'D2', 평균: 5 },
      ],
    }
    const names = { D1: '디일동', D2: '디이동' }
    const split = gridDongBinCounts(values, gridDong, scale, names, gridBreakdown)
    const old = gridDongBinCounts(values, gridDong, scale, names) // no breakdown

    const sBy = Object.fromEntries(split.rows.map((r) => [r.행정동코드, r]))
    const oBy = Object.fromEntries(old.rows.map((r) => [r.행정동코드, r]))
    const top = split.nBins - 1

    // D1 GAINS B's big portion (was 2 cells, now 3 portions); D2 keeps its total but
    // B's contribution moves from the TOP bin (whole cell 100) to the BOTTOM bin (5).
    expect(oBy.D1.total).toBe(2)
    expect(sBy.D1.total).toBe(3)
    expect(sBy.D2.total).toBe(3)
    expect(oBy.D2.total).toBe(3)
    expect(sBy.D2.counts[0]).toBe(oBy.D2.counts[0] + 1) // tiny portion → bin 0
    expect(sBy.D2.counts[top]).toBe(oBy.D2.counts[top] - 1) // whole-cell no longer here
  })

  it('with no gridBreakdown, output is identical to the legacy (whole-cell) counting', () => {
    const values = { c1: 10, c2: 20, B: 100 }
    const scale = buildColorScale(values)
    const gridDong = { c1: 'D1', c2: 'D2', B: 'D2' }
    const names = { D1: '디일', D2: '디이' }
    const a = gridDongBinCounts(values, gridDong, scale, names)
    const b = gridDongBinCounts(values, gridDong, scale, names, {}) // empty breakdown
    expect(b).toEqual(a)
  })
})

describe('binCountsToPct (100%-stacked conversion)', () => {
  it('converts counts to percentages of the row total', () => {
    expect(binCountsToPct({ counts: [1, 3], total: 4 })).toEqual([25, 75])
  })
  it('returns all-zero (never NaN) for a zero total', () => {
    expect(binCountsToPct({ counts: [0, 0, 0], total: 0 })).toEqual([0, 0, 0])
  })
  it('handles a nullish row defensively', () => {
    expect(binCountsToPct(undefined)).toEqual([])
    expect(binCountsToPct({})).toEqual([])
  })
  it('sums to ~100 for a non-trivial split', () => {
    const pct = binCountsToPct({ counts: [1, 1, 2], total: 4 })
    expect(pct).toEqual([25, 25, 50])
    expect(pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9)
  })
})

describe('hourlySeries (24-hour aggregation)', () => {
  it('aggregates Σ값 per 시간 into a dense 24-length array', () => {
    const series = [
      { 시간: 0, code: 'X', 값: 10 },
      { 시간: 0, code: 'Y', 값: 5 },
      { 시간: 5, code: 'X', 값: 100 },
      { 시간: 23, code: 'X', 값: 7 },
    ]
    const { hours, totals } = hourlySeries(series)
    expect(hours).toHaveLength(24)
    expect(hours[0]).toBe(0)
    expect(hours[23]).toBe(23)
    expect(totals[0]).toBe(15) // 10 + 5
    expect(totals[5]).toBe(100)
    expect(totals[23]).toBe(7)
    expect(totals[1]).toBe(0) // missing hour → 0
  })

  it('ignores out-of-range hours and non-finite 값', () => {
    const series = [
      { 시간: 24, code: 'X', 값: 999 }, // out of range
      { 시간: -1, code: 'X', 값: 999 }, // out of range
      { 시간: 3, code: 'X', 값: null }, // non-finite
      { 시간: 3, code: 'Y', 값: 8 },
    ]
    const { totals } = hourlySeries(series)
    expect(totals[3]).toBe(8)
    // Out-of-range hours never index a valid slot.
    expect(totals.reduce((a, b) => a + b, 0)).toBe(8)
  })

  it('empty series → all zeros', () => {
    const { totals } = hourlySeries([])
    expect(totals).toHaveLength(24)
    expect(totals.every((v) => v === 0)).toBe(true)
  })
})

describe('trendAverages (월/주 평균 = 합계/(일수×시간수))', () => {
  it('derives 평균 per 라벨 and preserves input (라벨 ascending) order', () => {
    const points = [
      { 라벨: '202401', 합계: 588846159.2, 일수: 31 },
      { 라벨: '202402', 합계: 548735974.69, 일수: 29 },
    ]
    const out = trendAverages(points, 24)
    expect(out.map((p) => p.라벨)).toEqual(['202401', '202402'])
    // 588846159.2 / (31×24) = 791459.62…
    expect(out[0].평균).toBeCloseTo(588846159.2 / (31 * 24), 3)
    expect(out[1].평균).toBeCloseTo(548735974.69 / (29 * 24), 3)
  })

  it('handles week 라벨 (연주 "YYYY-WW") the same way', () => {
    const points = [{ 라벨: '2026-23', 합계: 3360, 일수: 7 }]
    // 3360 / (7×24) = 20
    expect(trendAverages(points, 24)[0].라벨).toBe('2026-23')
    expect(trendAverages(points, 24)[0].평균).toBe(20)
  })

  it('falls back to a legacy 연월 key when 라벨 is absent', () => {
    const points = [{ 연월: '202401', 합계: 720, 일수: 30 }]
    const out = trendAverages(points, 24)
    expect(out[0].라벨).toBe('202401')
    expect(out[0].평균).toBe(1) // 720/(30×24)
  })

  it('시간수 narrows the denominator (subset hours)', () => {
    const points = [{ 라벨: '202406', 합계: 7200, 일수: 30 }]
    // 시간수 10 → 7200/(30×10) = 24
    expect(trendAverages(points, 10)[0].평균).toBe(24)
    // 시간수 24 → 7200/(30×24) = 10
    expect(trendAverages(points, 24)[0].평균).toBe(10)
  })

  it('null/0 일수 → 평균 null (a gap, never 0/NaN)', () => {
    const points = [
      { 라벨: '202401', 합계: 1000, 일수: null },
      { 라벨: '202402', 합계: 1000, 일수: 0 },
    ]
    const out = trendAverages(points, 24)
    expect(out[0].평균).toBeNull()
    expect(out[1].평균).toBeNull()
  })

  it('시간수 ≤ 0 → all 평균 null (no divide-by-zero)', () => {
    const points = [{ 라벨: '202401', 합계: 1000, 일수: 30 }]
    expect(trendAverages(points, 0)[0].평균).toBeNull()
  })

  it('nullish/ non-finite 합계 → 평균 null (no spurious 0)', () => {
    const points = [
      { 라벨: '202401', 합계: null, 일수: 30 },
      { 라벨: '202402', 합계: undefined, 일수: 30 },
    ]
    const out = trendAverages(points, 24)
    expect(out[0].평균).toBeNull()
    expect(out[1].평균).toBeNull()
  })

  it('empty / nullish points → empty array', () => {
    expect(trendAverages([], 24)).toEqual([])
    expect(trendAverages(null, 24)).toEqual([])
    expect(trendAverages(undefined, 24)).toEqual([])
  })

  it('skips points with no 라벨/연월', () => {
    const points = [{ 합계: 1000, 일수: 30 }, { 라벨: '202401', 합계: 720, 일수: 30 }]
    const out = trendAverages(points, 24)
    expect(out).toHaveLength(1)
    expect(out[0].라벨).toBe('202401')
    expect(out[0].평균).toBe(1) // 720/(30×24)
  })
})

describe('dayTrendAverages (일별 평균 = 합계/시간수, 일수=1)', () => {
  it('derives 평균 per 일자 and preserves 일자 ascending order', () => {
    const series = [
      { 일자: '2026-05-06', 합계: 18000 },
      { 일자: '2026-05-07', 합계: 24000 },
    ]
    const out = dayTrendAverages(series, 24)
    expect(out.map((p) => p.일자)).toEqual(['2026-05-06', '2026-05-07'])
    expect(out[0].평균).toBe(750) // 18000/24
    expect(out[1].평균).toBe(1000) // 24000/24
  })

  it('시간수 is the only denominator (no 일수 factor)', () => {
    const series = [{ 일자: '2026-05-06', 합계: 1200 }]
    expect(dayTrendAverages(series, 10)[0].평균).toBe(120) // 1200/10
    expect(dayTrendAverages(series, 24)[0].평균).toBe(50) // 1200/24
  })

  it('시간수 ≤ 0 or non-finite 합계 → 평균 null (no divide-by-zero / spurious 0)', () => {
    expect(dayTrendAverages([{ 일자: '2026-05-06', 합계: 1000 }], 0)[0].평균).toBeNull()
    expect(dayTrendAverages([{ 일자: '2026-05-06', 합계: null }], 24)[0].평균).toBeNull()
    expect(dayTrendAverages([{ 일자: '2026-05-06', 합계: undefined }], 24)[0].평균).toBeNull()
  })

  it('skips points with no 일자; empty/nullish → empty array', () => {
    const out = dayTrendAverages([{ 합계: 1000 }, { 일자: '2026-05-06', 합계: 240 }], 24)
    expect(out).toHaveLength(1)
    expect(out[0].일자).toBe('2026-05-06')
    expect(dayTrendAverages([], 24)).toEqual([])
    expect(dayTrendAverages(null, 24)).toEqual([])
    expect(dayTrendAverages(undefined, 24)).toEqual([])
  })
})
