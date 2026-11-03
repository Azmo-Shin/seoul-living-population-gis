// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { bboxOf, centroidOf } from './bbox.js'

// A tiny square Polygon helper (closed ring) centered on [lng, lat] with radius r.
const square = (lng, lat, r) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng - r, lat - r],
      [lng + r, lat - r],
      [lng + r, lat + r],
      [lng - r, lat + r],
      [lng - r, lat - r],
    ],
  ],
})

const fc = (...geometries) => ({
  type: 'FeatureCollection',
  features: geometries.map((geometry) => ({ type: 'Feature', geometry })),
})

describe('bboxOf', () => {
  it('returns null for null / empty FeatureCollection', () => {
    expect(bboxOf(null)).toBeNull()
    expect(bboxOf(undefined)).toBeNull()
    expect(bboxOf({ type: 'FeatureCollection', features: [] })).toBeNull()
  })

  it('computes the extent of a single Polygon feature', () => {
    const geo = fc(square(127, 37.5, 0.1))
    expect(bboxOf(geo)).toEqual([
      [126.9, 37.4],
      [127.1, 37.6],
    ])
  })

  it('unions the extent across multiple features', () => {
    const geo = fc(square(126.9, 37.4, 0.05), square(127.2, 37.7, 0.05))
    const [[minLng, minLat], [maxLng, maxLat]] = bboxOf(geo)
    // toBeCloseTo to avoid float-add artifacts (127.2 + 0.05 ≠ exactly 127.25).
    expect(minLng).toBeCloseTo(126.85, 6)
    expect(minLat).toBeCloseTo(37.35, 6)
    expect(maxLng).toBeCloseTo(127.25, 6)
    expect(maxLat).toBeCloseTo(37.75, 6)
  })

  it('handles MultiPolygon coordinates (deeper nesting)', () => {
    const geo = fc({
      type: 'MultiPolygon',
      coordinates: [
        square(127, 37.5, 0.1).coordinates,
        square(127.3, 37.8, 0.1).coordinates,
      ],
    })
    const [[minLng, minLat], [maxLng, maxLat]] = bboxOf(geo)
    expect(minLng).toBeCloseTo(126.9, 6)
    expect(minLat).toBeCloseTo(37.4, 6)
    expect(maxLng).toBeCloseTo(127.4, 6)
    expect(maxLat).toBeCloseTo(37.9, 6)
  })

  it('accepts a bare geometry (not wrapped in a FeatureCollection)', () => {
    expect(bboxOf(square(127, 37.5, 0.2))).toEqual([
      [126.8, 37.3],
      [127.2, 37.7],
    ])
  })

  it('accepts a single Feature', () => {
    const feature = { type: 'Feature', geometry: square(127, 37.5, 0.1) }
    expect(bboxOf(feature)).toEqual([
      [126.9, 37.4],
      [127.1, 37.6],
    ])
  })

  it('ignores non-finite coordinates and degenerate geometries', () => {
    const geo = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: null },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [NaN, 37.5],
                [127, Infinity],
              ],
            ],
          },
        },
        { type: 'Feature', geometry: square(127, 37.5, 0.1) },
      ],
    }
    // Only the valid square contributes.
    expect(bboxOf(geo)).toEqual([
      [126.9, 37.4],
      [127.1, 37.6],
    ])
  })

  it('returns null when every coordinate is non-finite', () => {
    const geo = fc({
      type: 'Polygon',
      coordinates: [
        [
          [NaN, NaN],
          [Infinity, -Infinity],
        ],
      ],
    })
    expect(bboxOf(geo)).toBeNull()
  })
})

describe('centroidOf', () => {
  it('returns the bbox center of a single Polygon feature', () => {
    const geo = fc(square(127, 37.5, 0.1))
    expect(centroidOf(geo)).toEqual([127, 37.5])
  })

  it('returns the bbox center across multiple features', () => {
    const geo = fc(square(126.9, 37.4, 0.05), square(127.2, 37.7, 0.05))
    const [lng, lat] = centroidOf(geo)
    // center of union bbox [[126.85,37.35],[127.25,37.75]]
    expect(lng).toBeCloseTo(127.05, 6)
    expect(lat).toBeCloseTo(37.55, 6)
  })

  it('accepts a single Feature', () => {
    const feature = { type: 'Feature', geometry: square(127, 37.5, 0.2) }
    expect(centroidOf(feature)).toEqual([127, 37.5])
  })

  it('accepts a bare geometry', () => {
    expect(centroidOf(square(127, 37.5, 0.2))).toEqual([127, 37.5])
  })

  it('returns null when no finite coordinate exists', () => {
    expect(centroidOf(null)).toBeNull()
    expect(centroidOf({ type: 'FeatureCollection', features: [] })).toBeNull()
    const bad = fc({
      type: 'Polygon',
      coordinates: [
        [
          [NaN, NaN],
          [Infinity, -Infinity],
        ],
      ],
    })
    expect(centroidOf(bad)).toBeNull()
  })
})
