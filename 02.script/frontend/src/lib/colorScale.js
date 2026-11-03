// colorScale.js — pure, unit-testable Spectral DIVERGING quantile color scale.
//
// Given the current `values` object ({ [code]: number }) it computes 6 QUANTILE
// bins and a mapping value → [r,g,b] along a reversed-Spectral (blue→red) ramp so
// the LOWEST bin reads BLUE, the middle teal/green/yellow, the HIGHEST bin RED:
//   low  = blue   (#3288bd)
//   mid  = green/yellow
//   high = red    (#d53e4f)
// This is the standard ColorBrewer Spectral, REVERSED, so HIGH values = RED for
// maximal distinguishability (the old monochrome white→green ramp was hard to
// tell apart). Quantile (rank-based) breaks — NOT linear — so the hue spread
// reflects the rank distribution of the data rather than its absolute range.
//
// Design constraints honored here:
//   - No-data (null/undefined/NaN/not-in-values) → a light neutral GRAY, distinct
//     from any ramp hue, so empty features read as "데이터 없음".
//   - Edge cases (all-equal values, <6 distinct values) collapse bins without
//     crashing; bins stay monotone in INDEX (low→blue, high→red along the ramp).
//   - PURE: no React/store/deck.gl imports. The Legend renders the SAME bins so
//     map fill and legend stay perfectly consistent.

const N_BINS = 6

// No-data swatch: light neutral gray. Alpha kept slightly below opaque so empty
// features read as clearly "absent" rather than a faint hue.
export const NO_DATA_COLOR = [233, 233, 233]
export const NO_DATA_ALPHA = 140

// Reversed-Spectral diverging ramp anchors (low→high). ColorBrewer Spectral,
// reversed so the LOW end is BLUE (#3288bd) and the HIGH end is RED (#d53e4f):
//   blue → teal → light-green → yellow-green → yellow → orange → orange-red → RED
// N swatches are interpolated EVENLY across these 8 anchors (the ramp lightness is
// NOT monotone — it rises to yellow at the middle then falls to red — so swatches
// are monotone in INDEX/hue-position, not in luminance).
const RAMP_STOPS = [
  [50, 136, 189], //  #3288bd  blue        (LOW)
  [102, 194, 165], // #66c2a5  teal
  [171, 221, 164], // #abdda4  light-green
  [230, 245, 152], // #e6f598  yellow-green
  [254, 224, 139], // #fee08b  yellow
  [253, 174, 97], //  #fdae61  orange
  [244, 109, 67], //  #f46d43  orange-red
  [213, 62, 79], //   #d53e4f  RED         (HIGH)
]

// Linear interpolate between two [r,g,b] colors at t∈[0,1].
function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

// Sample the multi-stop ramp at t∈[0,1] → [r,g,b]. Interpolates across the
// RAMP_STOPS anchors piecewise (segment = floor(t * (S-1))), so t=0 → blue,
// t=1 → red, and intermediate t walks the Spectral hues in between.
function rampColor(t) {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t
  const segs = RAMP_STOPS.length - 1
  if (clamped >= 1) return [...RAMP_STOPS[segs]]
  const scaled = clamped * segs
  const i = Math.floor(scaled)
  return lerpColor(RAMP_STOPS[i], RAMP_STOPS[i + 1], scaled - i)
}

// The N evenly-spaced swatch colors of the ramp (bin i → t = i/(N-1)).
// Monotonic in INDEX by construction: higher index → further toward the RED end
// (low index = blue, high index = red), never backward.
function swatchColors(n = N_BINS) {
  if (n <= 1) return [rampColor(1)] // single-bin degenerate: use the RED high end
  return Array.from({ length: n }, (_, i) => rampColor(i / (n - 1)))
}

// Quantile value of a SORTED ascending numeric array at fraction q∈[0,1].
// Linear interpolation between order statistics (type-7-ish).
function quantileSorted(sorted, q) {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * Build a Spectral-diverging (low=blue, high=red) quantile color scale from a
 * `values` object.
 *
 * @param {Record<string, number> | number[]} values
 *   The color metric per code (or a raw numeric array). Non-finite / nullish
 *   entries are ignored when computing breaks.
 * @param {number} [nBins=6]
 * @returns {{
 *   getColor: (value: number|null|undefined) => [number,number,number],
 *   bins: Array<{min:number, max:number, color:[number,number,number]}>,
 *   breaks: number[],
 *   noDataColor: [number,number,number],
 *   isEmpty: boolean,
 * }}
 *
 * - `getColor(v)` → the bin color for v, or the no-data gray for nullish/NaN.
 * - `bins` → the 6 swatches with their [min,max] value range (for the Legend).
 *   Degenerate inputs collapse to FEWER bins (e.g. all-equal → 1 bin) so the
 *   Legend never shows empty/duplicate ranges.
 * - `breaks` → the internal quantile break points (length nBins+1: min..max).
 */
export function buildColorScale(values, nBins = N_BINS) {
  const arr = Array.isArray(values) ? values : Object.values(values ?? {})
  const nums = arr
    .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
    .map(Number)
    .sort((a, b) => a - b)

  // No data at all → everything is gray.
  if (nums.length === 0) {
    return {
      getColor: () => NO_DATA_COLOR,
      bins: [],
      breaks: [],
      noDataColor: NO_DATA_COLOR,
      isEmpty: true,
    }
  }

  const min = nums[0]
  const max = nums[nums.length - 1]
  const distinct = Array.from(new Set(nums))

  // ── Degenerate: all values equal → a single bin (one swatch). ──────────────
  if (min === max) {
    const color = swatchColors(1)[0]
    return {
      getColor: (v) =>
        v === null || v === undefined || !Number.isFinite(Number(v))
          ? NO_DATA_COLOR
          : color,
      bins: [{ min, max, color }],
      breaks: [min, max],
      noDataColor: NO_DATA_COLOR,
      isEmpty: false,
    }
  }

  // ── Fewer distinct values than bins → collapse bins to distinct count. ─────
  // Avoids degenerate quantiles producing duplicate/empty ranges; the ramp is
  // sampled at the reduced count so swatches stay monotone & visually distinct.
  const effBins = Math.min(nBins, distinct.length)
  const colors = swatchColors(effBins)

  // Quantile breaks: effBins+1 cut points from min..max. Monotonic non-decreasing.
  const breaks = Array.from({ length: effBins + 1 }, (_, i) =>
    quantileSorted(nums, i / effBins),
  )
  // Defensive: force strict-enough monotonicity for assignment (ties → nudge up
  // the upper edge so a value never falls "between" two identical breaks).
  for (let i = 1; i < breaks.length; i++) {
    if (breaks[i] < breaks[i - 1]) breaks[i] = breaks[i - 1]
  }

  const bins = colors.map((color, i) => ({
    min: breaks[i],
    max: breaks[i + 1],
    color,
  }))

  // Map a numeric value → its bin index via the quantile breaks. Values land in
  // bin i when breaks[i] <= v < breaks[i+1]; the top edge (== max) → last bin.
  function binIndexFor(v) {
    if (v <= breaks[0]) return 0
    if (v >= breaks[breaks.length - 1]) return effBins - 1
    for (let i = 0; i < effBins; i++) {
      if (v >= breaks[i] && v < breaks[i + 1]) return i
    }
    return effBins - 1
  }

  function getColor(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) {
      return NO_DATA_COLOR
    }
    return colors[binIndexFor(Number(v))]
  }

  return {
    getColor,
    bins,
    breaks,
    noDataColor: NO_DATA_COLOR,
    isEmpty: false,
  }
}

export default buildColorScale
