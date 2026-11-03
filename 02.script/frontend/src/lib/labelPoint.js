// labelPoint.js — interior label anchor for GeoJSON polygons via the "pole of
// inaccessibility" (polylabel): the point INSIDE a polygon that is farthest from
// any edge. This replaces the old bbox-center anchor (centroidOf), which lands
// OUTSIDE or near the edge of concave / L-shaped / river-split / multipart 동·구
// polygons — so labels drift off the visible shape. The pole of inaccessibility is
// always strictly inside the polygon and sits in its largest open region, which is
// exactly where a name label reads best.
//
// Vendored (no dependency) from Mapbox's polylabel, trimmed + adapted:
//   - rings are [lng,lat] treated as PLANAR — admin areas are small enough that
//     meridian convergence is negligible for placing a text anchor.
//   - MultiPolygon → run on the LARGEST sub-polygon (by outer-ring area), so the
//     label lands in the biggest landmass, not averaged into the water between parts.
//   - inner rings (holes) are honored, so a label never lands in a hole.
// Falls back to the bbox center (centroidOf) for non-polygon or degenerate geometry.
import { centroidOf } from './bbox.js'

// Minimal binary MAX-heap keyed by `.max` (a cell's best-possible distance). Avoids
// pulling in tinyqueue; polylabel only needs push / pop-max.
class MaxHeap {
  constructor() {
    this.a = []
  }
  get length() {
    return this.a.length
  }
  push(item) {
    const a = this.a
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].max >= a[i].max) break
      const t = a[p]
      a[p] = a[i]
      a[i] = t
      i = p
    }
  }
  pop() {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length > 0) {
      a[0] = last
      let i = 0
      const n = a.length
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < n && a[l].max > a[m].max) m = l
        if (r < n && a[r].max > a[m].max) m = r
        if (m === i) break
        const t = a[m]
        a[m] = a[i]
        a[i] = t
        i = m
      }
    }
    return top
  }
}

// Squared distance from point (px,py) to segment a–b. Squared to avoid sqrt in the
// inner loop (we only sqrt the final minimum).
function segDistSq(px, py, a, b) {
  let x = a[0]
  let y = a[1]
  let dx = b[0] - x
  let dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) {
      x = b[0]
      y = b[1]
    } else if (t > 0) {
      x += dx * t
      y += dy * t
    }
  }
  dx = px - x
  dy = py - y
  return dx * dx + dy * dy
}

// SIGNED distance from (x,y) to a polygon (array of rings; ring[0]=outer, rest=holes).
// Positive when inside (even-odd ray cast), negative outside; magnitude = distance to
// the nearest edge. This is the score polylabel maximizes.
function pointToPolygonDist(x, y, polygon) {
  let inside = false
  let minDistSq = Infinity
  for (const ring of polygon) {
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (
        a[1] > y !== b[1] > y &&
        x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
      ) {
        inside = !inside
      }
      const d = segDistSq(x, y, a, b)
      if (d < minDistSq) minDistSq = d
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minDistSq)
}

// A candidate square cell: center (x,y), half-size h, signed distance d to the
// polygon, and `max` = the best distance any point in the cell could possibly have
// (d + half-diagonal). `max` drives the priority queue + the prune test.
function makeCell(x, y, h, polygon) {
  const d = pointToPolygonDist(x, y, polygon)
  return { x, y, h, d, max: d + h * Math.SQRT2 }
}

// Area-weighted centroid of the outer ring, as a seed cell (a good first guess that
// is usually already inside convex-ish shapes).
function centroidCell(polygon) {
  let area = 0
  let x = 0
  let y = 0
  const points = polygon[0]
  for (let i = 0, len = points.length, j = len - 1; i < len; j = i++) {
    const a = points[i]
    const b = points[j]
    const f = a[0] * b[1] - b[0] * a[1]
    x += (a[0] + b[0]) * f
    y += (a[1] + b[1]) * f
    area += f * 3
  }
  if (area === 0) return makeCell(points[0][0], points[0][1], 0, polygon)
  return makeCell(x / area, y / area, 0, polygon)
}

/**
 * Pole of inaccessibility of a single polygon (rings array). Returns [x,y] — the
 * interior point farthest from any edge.
 * @param {number[][][]} polygon  [outerRing, ...holeRings]; ring = [[x,y], …]
 * @param {number} [precision]  stop when no cell can beat the best by more than this;
 *   defaults to bbox_max_dimension / 1000 so it adapts to degree-scale coordinates.
 * @returns {[number, number]}
 */
export function polylabel(polygon, precision) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polygon[0]) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  const width = maxX - minX
  const height = maxY - minY
  const cellSize = Math.min(width, height)
  if (cellSize <= 0) return [minX, minY] // degenerate (line/point)

  const prec = precision ?? Math.max(width, height) / 1000
  const h = cellSize / 2
  const heap = new MaxHeap()

  // Tile the bbox with cellSize squares as the initial frontier.
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      heap.push(makeCell(x + h, y + h, h, polygon))
    }
  }

  // Best-so-far: area centroid, then the bbox center if that's better.
  let best = centroidCell(polygon)
  const bboxCenter = makeCell(minX + width / 2, minY + height / 2, 0, polygon)
  if (bboxCenter.d > best.d) best = bboxCenter

  while (heap.length) {
    const cell = heap.pop()
    if (cell.d > best.d) best = cell
    // Prune: if even this cell's optimistic best can't beat `best` by `prec`, drop it.
    if (cell.max - best.d <= prec) continue
    const hh = cell.h / 2
    heap.push(makeCell(cell.x - hh, cell.y - hh, hh, polygon))
    heap.push(makeCell(cell.x + hh, cell.y - hh, hh, polygon))
    heap.push(makeCell(cell.x - hh, cell.y + hh, hh, polygon))
    heap.push(makeCell(cell.x + hh, cell.y + hh, hh, polygon))
  }
  return [best.x, best.y]
}

// Shoelace area (absolute) of a ring — used to pick the largest part of a MultiPolygon.
function ringArea(ring) {
  let area = 0
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
  }
  return Math.abs(area) / 2
}

// Extract the polygon (rings array) to label from a Feature / bare Geometry. For a
// MultiPolygon, the largest part by outer-ring area. null for non-polygon geometry.
function pickPolygon(geo) {
  const geom = geo?.type === 'Feature' ? geo.geometry : geo
  if (!geom) return null
  if (geom.type === 'Polygon') return geom.coordinates
  if (geom.type === 'MultiPolygon') {
    let best = null
    let bestArea = -1
    for (const poly of geom.coordinates ?? []) {
      const a = poly?.[0] ? ringArea(poly[0]) : -1
      if (a > bestArea) {
        bestArea = a
        best = poly
      }
    }
    return best
  }
  return null
}

/**
 * Is [x,y] inside `polygon` (rings array; holes honored)? Exposed for verification +
 * callers that want to sanity-check an anchor. Boundary counts as inside (d ≥ 0).
 */
export function isInsidePolygon(point, polygon) {
  return pointToPolygonDist(point[0], point[1], polygon) >= 0
}

/**
 * Interior label anchor for a GeoJSON Feature / Geometry: the pole of inaccessibility
 * of its (largest) polygon. Falls back to the bbox center for non-polygon or
 * degenerate geometry so every labelable feature still gets a point.
 * @param {object|null} geo
 * @returns {[number, number] | null} `[lng, lat]`, or null when un-labelable.
 */
export function labelPointOf(geo) {
  const polygon = pickPolygon(geo)
  if (!Array.isArray(polygon) || !Array.isArray(polygon[0]) || polygon[0].length < 3) {
    return centroidOf(geo) // non-polygon / degenerate → cheap bbox-center fallback
  }
  // polylabel uses planar Euclidean distance, but lng degrees are SHORTER than lat
  // degrees away from the equator (×cos lat) — so maximizing raw-degree distance
  // biases the anchor off the true-METERS pole. Scale lng by cos(lat0) into a locally
  // isotropic space, solve there, then unscale. lat0 = mean lat of the outer ring.
  const outer = polygon[0]
  let latSum = 0
  for (const p of outer) latSum += p[1]
  const kx = Math.cos(((latSum / outer.length) * Math.PI) / 180) || 1
  const scaled = polygon.map((ring) => ring.map(([lng, lat]) => [lng * kx, lat]))
  const p = polylabel(scaled)
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return centroidOf(geo)
  return [p[0] / kx, p[1]] // unscale lng back to degrees
}

export default labelPointOf
