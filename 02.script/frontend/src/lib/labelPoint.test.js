import { describe, it, expect } from 'vitest'
import { labelPointOf, polylabel, isInsidePolygon } from './labelPoint.js'
import { centroidOf } from './bbox.js'

// A "C" / horseshoe: left bar (x 0–4, full height) + top & bottom bars (x 4–10).
// The bbox is [0,0]–[10,10] so the bbox CENTER (5,5) falls in the open notch →
// OUTSIDE the shape. This is the failure mode that drifts 동 labels off the polygon.
const C_RING = [
  [0, 0],
  [10, 0],
  [10, 4],
  [4, 4],
  [4, 6],
  [10, 6],
  [10, 10],
  [0, 10],
  [0, 0],
]
const C_FEATURE = {
  type: 'Feature',
  geometry: { type: 'Polygon', coordinates: [C_RING] },
}

describe('isInsidePolygon (ray cast, holes honored)', () => {
  it('classifies the bbox-center of a C-shape as OUTSIDE', () => {
    expect(isInsidePolygon([5, 5], [C_RING])).toBe(false)
  })
  it('classifies a point in the left bar as INSIDE', () => {
    expect(isInsidePolygon([2, 5], [C_RING])).toBe(true)
  })
  it('respects holes (donut center is outside)', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    const hole = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]
    expect(isInsidePolygon([5, 5], [outer, hole])).toBe(false)
    expect(isInsidePolygon([1, 1], [outer, hole])).toBe(true)
  })
})

describe('polylabel (pole of inaccessibility)', () => {
  it('returns a point INSIDE a concave shape where the bbox center is outside', () => {
    const p = polylabel([C_RING])
    expect(isInsidePolygon(p, [C_RING])).toBe(true)
    // sanity: the OLD basis (bbox center) was outside — this is the bug being fixed.
    expect(isInsidePolygon(centroidOf(C_FEATURE), [C_RING])).toBe(false)
  })

  it('lands near the true center for a simple square', () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    const p = polylabel([sq])
    expect(p[0]).toBeGreaterThan(3)
    expect(p[0]).toBeLessThan(7)
    expect(p[1]).toBeGreaterThan(3)
    expect(p[1]).toBeLessThan(7)
  })

  it('avoids a hole (label not inside the donut hole)', () => {
    const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]
    const hole = [[6, 6], [14, 6], [14, 14], [6, 14], [6, 6]]
    const p = polylabel([outer, hole])
    expect(isInsidePolygon(p, [outer, hole])).toBe(true)
  })
})

describe('labelPointOf (Feature → interior anchor)', () => {
  it('puts the anchor inside a concave Polygon feature', () => {
    const p = labelPointOf(C_FEATURE)
    expect(isInsidePolygon(p, [C_RING])).toBe(true)
  })

  it('uses the LARGEST part of a MultiPolygon', () => {
    // tiny part near origin + big part to the right; anchor must be in the big one.
    const small = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]
    const bigRing = [[10, 0], [30, 0], [30, 20], [10, 20], [10, 0]]
    const feat = {
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: [small, [bigRing]] },
    }
    const p = labelPointOf(feat)
    expect(isInsidePolygon(p, [bigRing])).toBe(true)
    expect(isInsidePolygon(p, small)).toBe(false) // not in the tiny part
  })

  it('falls back to bbox-center for non-polygon geometry', () => {
    const pt = { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 7] } }
    expect(labelPointOf(pt)).toEqual([3, 7])
  })

  it('returns null for un-labelable geometry', () => {
    expect(labelPointOf(null)).toBeNull()
    expect(labelPointOf({ type: 'Feature', geometry: null })).toBeNull()
  })
})
