// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { isoWeekMonday, isoWeekRange, isoWeekRangeLabel } from './isoWeek.js'

describe('isoWeekRange (ISO-8601 Mon–Sun)', () => {
  it('2025-W23 → 2025-06-02 ~ 2025-06-08 (the spec example)', () => {
    const { start, end } = isoWeekRange(2025, 23)
    expect(start).toBe('2025-06-02')
    expect(end).toBe('2025-06-08')
  })

  it('week 1 starts on the Monday of the week containing Jan 4', () => {
    // 2025: Jan 4 is a Saturday → week 1 Monday is Dec 30, 2024 (prior year).
    expect(isoWeekRange(2025, 1).start).toBe('2024-12-30')
    expect(isoWeekRange(2025, 1).end).toBe('2025-01-05')
  })

  it('handles a year whose Jan 1 IS a Monday (2024)', () => {
    // 2024: Jan 1 is a Monday → week 1 = Jan 1..Jan 7.
    expect(isoWeekRange(2024, 1).start).toBe('2024-01-01')
    expect(isoWeekRange(2024, 1).end).toBe('2024-01-07')
  })

  it('handles a 53-week year (2020 has W53)', () => {
    // 2020 is a long ISO year; W53 Monday = 2020-12-28, Sun = 2021-01-03.
    expect(isoWeekRange(2020, 53).start).toBe('2020-12-28')
    expect(isoWeekRange(2020, 53).end).toBe('2021-01-03')
  })

  it('start/end span exactly 7 days (Mon..Sun)', () => {
    const { startDate, endDate } = isoWeekRange(2025, 23)
    const days = (endDate.getTime() - startDate.getTime()) / 86400000
    expect(days).toBe(6)
    // Monday (UTC day 1) and Sunday (UTC day 0).
    expect(startDate.getUTCDay()).toBe(1)
    expect(endDate.getUTCDay()).toBe(0)
  })

  it('isoWeekMonday returns the Monday at 00:00 UTC', () => {
    const m = isoWeekMonday(2025, 23)
    expect(m.getUTCFullYear()).toBe(2025)
    expect(m.getUTCMonth()).toBe(5) // June (0-indexed)
    expect(m.getUTCDate()).toBe(2)
    expect(m.getUTCHours()).toBe(0)
  })

  it('accepts numeric strings (parsed values from "YYYY-WW")', () => {
    expect(isoWeekRange('2025', '23').start).toBe('2025-06-02')
  })
})

describe('isoWeekRangeLabel', () => {
  it('formats a compact MM.DD – MM.DD range', () => {
    expect(isoWeekRangeLabel(2025, 23)).toBe('06.02 – 06.08')
  })
  it('zero-pads month and day', () => {
    // 2024-W1 → 01.01 – 01.07
    expect(isoWeekRangeLabel(2024, 1)).toBe('01.01 – 01.07')
  })
})
