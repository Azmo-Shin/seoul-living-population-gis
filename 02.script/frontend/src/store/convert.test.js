// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { featuresToValues, featuresToGridDong } from './convert.js'

describe('featuresToValues', () => {
  it('returns an empty map for an empty array', () => {
    const { valuesByCode } = featuresToValues([])
    expect(valuesByCode).toEqual({})
  })

  it('returns an empty map when called with no argument (default [])', () => {
    const { valuesByCode } = featuresToValues()
    expect(valuesByCode).toEqual({})
  })

  it('carries BOTH the sum and the daily average per code', () => {
    const features = [{ code: '11110', 합계: 1000, 일평균: 33.3 }]
    const { valuesByCode } = featuresToValues(features)
    expect(valuesByCode['11110']).toEqual({ 합계: 1000, 일평균: 33.3 })
  })

  it('preserves a null 일평균 (color metric 평균 is derived later by the store)', () => {
    const features = [{ code: '11140', 합계: 500, 일평균: null }]
    const { valuesByCode } = featuresToValues(features)
    expect(valuesByCode['11140']).toEqual({ 합계: 500, 일평균: null })
  })

  it('handles a mix of codes (some with 일평균, some null)', () => {
    const features = [
      { code: 'A', 합계: 10, 일평균: 2 },
      { code: 'B', 합계: 99, 일평균: null },
    ]
    const { valuesByCode } = featuresToValues(features)
    expect(valuesByCode).toEqual({
      A: { 합계: 10, 일평균: 2 },
      B: { 합계: 99, 일평균: null },
    })
  })

  it('preserves a 일평균 of 0 (0 is a valid average, not a missing value)', () => {
    const features = [{ code: 'Z', 합계: 7, 일평균: 0 }]
    const { valuesByCode } = featuresToValues(features)
    expect(valuesByCode['Z']).toEqual({ 합계: 7, 일평균: 0 })
  })
})

describe('featuresToGridDong', () => {
  it('returns an empty map for an empty array / no argument', () => {
    expect(featuresToGridDong([])).toEqual({})
    expect(featuresToGridDong()).toEqual({})
  })

  it('maps each 격자코드 to its 행정동코드 (grid level)', () => {
    const features = [
      { code: 'G1', 합계: 10, 일평균: 1, 행정동코드: '11680510' },
      { code: 'G2', 합계: 20, 일평균: 2, 행정동코드: '11680545' },
    ]
    expect(featuresToGridDong(features)).toEqual({
      G1: '11680510',
      G2: '11680545',
    })
  })

  it('omits features whose 행정동코드 is null / missing (gu/dong levels)', () => {
    const features = [
      { code: 'A', 합계: 5, 일평균: 1, 행정동코드: null },
      { code: 'B', 합계: 5, 일평균: 1 }, // no key at all
      { code: 'C', 합계: 5, 일평균: 1, 행정동코드: '11110515' },
    ]
    expect(featuresToGridDong(features)).toEqual({ C: '11110515' })
  })

  it('trims padded codes and 동 codes defensively', () => {
    const features = [{ code: ' G3 ', 합계: 1, 일평균: 1, 행정동코드: ' 11680560 ' }]
    expect(featuresToGridDong(features)).toEqual({ G3: '11680560' })
  })

  it('omits a feature with a blank (whitespace-only) 행정동코드', () => {
    const features = [{ code: 'G4', 합계: 1, 일평균: 1, 행정동코드: '   ' }]
    expect(featuresToGridDong(features)).toEqual({})
  })
})
