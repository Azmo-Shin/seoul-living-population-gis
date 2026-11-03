// Geo bounding-box helper — walks a GeoJSON FeatureCollection's geometry and
// returns the lng/lat extent as `[[minLng, minLat], [maxLng, maxLat]]` (the shape
// WebMercatorViewport.fitBounds expects). Used by MapView to fit the camera to the
// ACTIVE level's polygons on a drill/scope change.
//
// Supports the geometry types this dataset emits: Polygon, MultiPolygon, and (for
// robustness) Point/LineString/MultiPoint/MultiLineString/GeometryCollection.
// Anything non-finite is ignored. Returns null when no usable coordinate exists
// (empty FC, null geo, all-degenerate) so the caller can skip the fit.

// Recursively accumulate min/max over an arbitrarily-nested coordinate array.
// Leaf positions are `[lng, lat, ...]`; any deeper nesting (rings, polygons) is
// walked structurally so we don't special-case each geometry type's depth.
function _walk(coords, acc) {
  if (!Array.isArray(coords)) return
  // A position is an array whose first element is a number → leaf.
  if (typeof coords[0] === 'number') {
    const lng = coords[0]
    const lat = coords[1]
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      if (lng < acc.minLng) acc.minLng = lng
      if (lat < acc.minLat) acc.minLat = lat
      if (lng > acc.maxLng) acc.maxLng = lng
      if (lat > acc.maxLat) acc.maxLat = lat
      acc.found = true
    }
    return
  }
  for (let i = 0; i < coords.length; i++) _walk(coords[i], acc)
}

function _walkGeometry(geom, acc) {
  if (!geom) return
  if (geom.type === 'GeometryCollection') {
    const geoms = geom.geometries
    if (Array.isArray(geoms)) for (const g of geoms) _walkGeometry(g, acc)
    return
  }
  _walk(geom.coordinates, acc)
}

/**
 * Compute the bounding box of a GeoJSON FeatureCollection (or single Feature/
 * Geometry).
 * @param {object|null} geo - a FeatureCollection, Feature, or Geometry.
 * @returns {[[number, number], [number, number]] | null}
 *   `[[minLng, minLat], [maxLng, maxLat]]`, or null when no finite coordinate.
 */
export function bboxOf(geo) {
  if (!geo) return null
  const acc = {
    minLng: Infinity,
    minLat: Infinity,
    maxLng: -Infinity,
    maxLat: -Infinity,
    found: false,
  }

  if (geo.type === 'FeatureCollection') {
    const feats = geo.features
    if (Array.isArray(feats)) {
      for (const f of feats) _walkGeometry(f?.geometry, acc)
    }
  } else if (geo.type === 'Feature') {
    _walkGeometry(geo.geometry, acc)
  } else {
    // Bare geometry (Polygon/MultiPolygon/etc.).
    _walkGeometry(geo, acc)
  }

  if (!acc.found) return null
  return [
    [acc.minLng, acc.minLat],
    [acc.maxLng, acc.maxLat],
  ]
}

/**
 * Compute a representative label position (bbox center) for a GeoJSON
 * FeatureCollection / Feature / Geometry. Good enough to anchor a text label at
 * roughly the middle of a polygon — NOT a true area centroid, but cheap and
 * stable (no self-intersection / hole math). Returns null when the geometry has
 * no finite coordinate (so callers can skip un-labelable features).
 * @param {object|null} geo - a FeatureCollection, Feature, or Geometry.
 * @returns {[number, number] | null} `[lng, lat]`, or null.
 */
export function centroidOf(geo) {
  const b = bboxOf(geo)
  if (!b) return null
  const [[minLng, minLat], [maxLng, maxLat]] = b
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2]
}

export default bboxOf
