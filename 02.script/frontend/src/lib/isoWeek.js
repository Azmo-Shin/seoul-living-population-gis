// isoWeek.js — pure ISO-8601 week ↔ date-range helpers.
//
// The period sent to the backend in WEEK mode is "YYYY-WW" (ISO year-week, e.g.
// "2025-23"). That number alone doesn't tell the user WHEN the week is, so the
// PeriodPicker DISPLAYS the week's actual Mon–Sun date range. These helpers compute
// that range CLIENT-SIDE — no backend round-trip — and are pure/unit-testable.
//
// ISO-8601 rules implemented here:
//   - Weeks start on MONDAY.
//   - Week 1 is the week containing the year's first THURSDAY (equivalently, the
//     week containing Jan 4). So week 1's Monday can fall in the PREVIOUS calendar
//     year, and late-December dates can belong to week 1 of the NEXT year.
// All arithmetic is done in UTC to avoid DST/local-offset drift.

const MS_PER_DAY = 86400000

// JS getUTCDay(): Sun=0..Sat=6. ISO day-of-week: Mon=1..Sun=7.
function isoDow(date) {
  const d = date.getUTCDay()
  return d === 0 ? 7 : d
}

/**
 * Monday (00:00 UTC) of ISO week `week` in ISO year `year`, as a UTC Date.
 *
 * Algorithm: take Jan 4 (always in week 1), step back to that week's Monday, then
 * add (week-1) weeks. Robust across the year boundary (week 1's Monday may be in
 * December of the prior year; the last week may spill into January of the next).
 *
 * @param {number} year  ISO week-numbering year
 * @param {number} week  ISO week number (typically 1..52, 53 in long years)
 * @returns {Date} UTC Date at 00:00 of that week's Monday
 */
export function isoWeekMonday(year, week) {
  const y = Number(year)
  const w = Number(week)
  // Jan 4 of the ISO year is always in ISO week 1.
  const jan4 = new Date(Date.UTC(y, 0, 4))
  const jan4Dow = isoDow(jan4) // 1..7
  // Monday of week 1 = Jan 4 minus (its ISO weekday - 1) days.
  const week1Monday = new Date(jan4.getTime() - (jan4Dow - 1) * MS_PER_DAY)
  // Add (w - 1) whole weeks.
  return new Date(week1Monday.getTime() + (w - 1) * 7 * MS_PER_DAY)
}

// Format a UTC Date → "YYYY-MM-DD".
function fmtYmd(date) {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Date range (Mon–Sun) of ISO week `week` in ISO year `year`.
 *
 * @param {number} year
 * @param {number} week
 * @returns {{start: string, end: string, startDate: Date, endDate: Date}}
 *   start/end are "YYYY-MM-DD" strings; startDate/endDate the underlying UTC Dates.
 *   Returns null-safe NaN-free strings only for finite year/week; a non-finite
 *   input yields a range whose strings are computed but meaningless — callers pass
 *   parsed numbers from a bounded "YYYY-WW".
 *
 * Example: isoWeekRange(2025, 23) → { start: '2025-06-02', end: '2025-06-08' }.
 */
export function isoWeekRange(year, week) {
  const startDate = isoWeekMonday(year, week)
  const endDate = new Date(startDate.getTime() + 6 * MS_PER_DAY)
  return {
    start: fmtYmd(startDate),
    end: fmtYmd(endDate),
    startDate,
    endDate,
  }
}

/**
 * Compact display label for an ISO week's date range, e.g. "06.02 – 06.08".
 * Drops the year for brevity (the year Select sits right beside it). Uses an
 * en-dash with spaces. Pure string transform over isoWeekRange.
 *
 * @param {number} year
 * @param {number} week
 * @returns {string} "MM.DD – MM.DD"
 */
export function isoWeekRangeLabel(year, week) {
  const { startDate, endDate } = isoWeekRange(year, week)
  const md = (d) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(
      d.getUTCDate(),
    ).padStart(2, '0')}`
  return `${md(startDate)} – ${md(endDate)}`
}
