// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  buildColorScale,
  NO_DATA_COLOR,
} from './colorScale.js'

// Diverging-ramp helpers. The Spectral (blue→red) ramp is NOT monotone in
// luminance (lightness rises to yellow at the middle then falls to red), so the
// old "darkness proxy" is invalid. Instead we test the diverging invariants:
//   - the LOW end is BLUE-dominant  (B > R)
//   - the HIGH end is RED-dominant  (R > G && R > B)
//   - bins are monotone in INDEX, i.e. a higher value lands in a bin index ≥ a
//     lower value's bin index (further toward the red end).
const isRedDominant = (c) => c[0] > c[1] && c[0] > c[2]
const isBlueDominant = (c) => c[2] > c[0]

describe('buildColorScale', () => {
  it('produces 6 bins for a normal spread of values', () => {
    const values = {}
    for (let i = 0; i < 50; i++) values['c' + i] = i // 0..49
    const scale = buildColorScale(values)
    expect(scale.bins).toHaveLength(6)
    expect(scale.breaks).toHaveLength(7) // nBins + 1 cut points
    expect(scale.isEmpty).toBe(false)
    // breaks span the data range and are non-decreasing.
    expect(scale.breaks[0]).toBe(0)
    expect(scale.breaks[scale.breaks.length - 1]).toBe(49)
    for (let i = 1; i < scale.breaks.length; i++) {
      expect(scale.breaks[i]).toBeGreaterThanOrEqual(scale.breaks[i - 1])
    }
  })

  it('maps no-data (null/undefined/NaN/missing) to the neutral gray', () => {
    const scale = buildColorScale({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 })
    expect(scale.getColor(null)).toEqual(NO_DATA_COLOR)
    expect(scale.getColor(undefined)).toEqual(NO_DATA_COLOR)
    expect(scale.getColor(NaN)).toEqual(NO_DATA_COLOR)
    // Gray must NOT equal any data bin color (distinct from every ramp hue).
    for (const bin of scale.bins) {
      expect(bin.color).not.toEqual(NO_DATA_COLOR)
    }
  })

  it('returns all-gray + isEmpty for an empty values object (no crash)', () => {
    const scale = buildColorScale({})
    expect(scale.isEmpty).toBe(true)
    expect(scale.bins).toEqual([])
    expect(scale.getColor(5)).toEqual(NO_DATA_COLOR)
    expect(scale.getColor(null)).toEqual(NO_DATA_COLOR)
  })

  it('collapses to a single bin when all values are equal (no crash)', () => {
    const scale = buildColorScale({ a: 7, b: 7, c: 7, d: 7 })
    expect(scale.bins).toHaveLength(1)
    expect(scale.bins[0].min).toBe(7)
    expect(scale.bins[0].max).toBe(7)
    // a real value → the single ramp swatch; nullish → gray.
    expect(scale.getColor(7)).toEqual(scale.bins[0].color)
    expect(scale.getColor(7)).not.toEqual(NO_DATA_COLOR)
    expect(scale.getColor(null)).toEqual(NO_DATA_COLOR)
  })

  it('collapses bins when fewer than 6 distinct values exist (no crash)', () => {
    const scale = buildColorScale({ a: 1, b: 1, c: 2, d: 3 }) // 3 distinct
    expect(scale.bins.length).toBeLessThanOrEqual(3)
    expect(scale.bins.length).toBeGreaterThanOrEqual(1)
    // every value resolves to a non-gray color.
    for (const v of [1, 2, 3]) {
      expect(scale.getColor(v)).not.toEqual(NO_DATA_COLOR)
    }
  })

  it('is monotonic in bin index: higher value → bin further toward the RED end', () => {
    const values = {}
    for (let i = 0; i < 100; i++) values['c' + i] = i * 3.7 // spread
    const scale = buildColorScale(values)

    // Map a value to its bin index by matching getColor against the bin colors.
    const binIndexOf = (v) => {
      const c = scale.getColor(v)
      return scale.bins.findIndex((b) => b.color.every((ch, k) => ch === c[k]))
    }
    const probes = [0, 50, 100, 200, 300, 366]
    const indices = probes.map(binIndexOf)
    // Every probe resolves to a real bin (not no-data) ...
    for (const idx of indices) expect(idx).toBeGreaterThanOrEqual(0)
    // ... and the bin index is non-decreasing as the value rises (a high value's
    // bin index ≥ a low value's bin index — further toward the red end).
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1])
    }

    // Diverging endpoints: the BOTTOM bin is BLUE-dominant, the TOP bin is
    // RED-dominant (low = blue, high = red).
    const bottom = scale.bins[0].color
    const top = scale.bins[scale.bins.length - 1].color
    expect(isBlueDominant(bottom)).toBe(true)
    expect(isRedDominant(top)).toBe(true)
  })

  it('clamps out-of-range values to the end bins (min→first, max→last)', () => {
    const scale = buildColorScale({ a: 10, b: 20, c: 30, d: 40, e: 50, f: 60 })
    const first = scale.bins[0].color
    const last = scale.bins[scale.bins.length - 1].color
    expect(scale.getColor(-999)).toEqual(first) // below min → first/blue (low)
    expect(scale.getColor(99999)).toEqual(last) // above max → last/red (high)
    // and the diverging endpoints read correctly: low = blue, high = red.
    expect(isBlueDominant(first)).toBe(true)
    expect(isRedDominant(last)).toBe(true)
  })

  it('accepts a raw numeric array as well as a values object', () => {
    const scale = buildColorScale([5, 1, 4, 2, 3, 6])
    expect(scale.isEmpty).toBe(false)
    expect(scale.bins.length).toBeGreaterThanOrEqual(1)
    expect(scale.getColor(3)).not.toEqual(NO_DATA_COLOR)
  })

  it('ignores non-finite entries when computing breaks', () => {
    const scale = buildColorScale({ a: 1, b: null, c: 2, d: undefined, e: 3 })
    expect(scale.isEmpty).toBe(false)
    expect(scale.breaks[0]).toBe(1)
    expect(scale.breaks[scale.breaks.length - 1]).toBe(3)
  })
})
