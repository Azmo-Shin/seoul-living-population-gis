// panelState — derive the panel's display state ('loading' | 'error' | 'empty' |
// null) from the store's data slice for a given mode. Centralizes the precedence
// (Task 8 §D) so all three cards agree on WHAT to show and WHEN:
//
//   error    > loading > empty > null(ok)
//
// "empty" = a successful fetch returned no usable data for the current scope AND
// not loading AND no error:
//   - month/week: valuesByCode has 0 entries
//   - day:        dayseries is empty
// We never report "empty" while loading or on error (the spinner/error wins).
//
// Pure (no React) so it is unit-testable in a node env.

/**
 * @param {{loading?:boolean, error?:string|null, valuesByCode?:object, dayseries?:Array}} data
 * @param {'month'|'week'|'day'} mode
 * @returns {'loading'|'error'|'empty'|null}
 */
export function derivePanelState(data, mode) {
  if (!data) return 'loading'
  if (data.error) return 'error'
  if (data.loading) return 'loading'

  const hasData =
    mode === 'day'
      ? Array.isArray(data.dayseries) && data.dayseries.length > 0
      : !!data.valuesByCode && Object.keys(data.valuesByCode).length > 0

  return hasData ? null : 'empty'
}
