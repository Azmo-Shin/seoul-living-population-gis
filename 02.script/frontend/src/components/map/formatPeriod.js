// Shared period formatter for compare-mode chrome (A/B labels + the dual legends).
// Pretty-prints a stored period for the active mode's shape (defensive on shape):
//   month 'YYYYMM'      → 'YYYY-MM'
//   week  'YYYY-WW'     → 'YYYY W주'
//   day   'YYYY-MM-DD'  → as-is
// Kept in one place so CompareBadges and the Legend titles can't drift apart.
export function fmtPeriod(mode, period) {
  if (!period) return '—'
  const p = String(period)
  if (mode === 'month') {
    return p.length === 6 ? `${p.slice(0, 4)}-${p.slice(4)}` : p
  }
  if (mode === 'week') {
    const [y, w] = p.split('-')
    return w ? `${y} ${Number(w)}주` : p
  }
  return p // day: already 'YYYY-MM-DD'
}
