// MapView — the choropleth centerpiece. Composes deck.gl (GeoJsonLayer) OVER a
// Kakao Maps basemap and colors the CURRENT level's GeoJSON with a green
// sequential quantile scale built from data.values.
//
// Architecture (Kakao basemap + standalone deck.gl overlay):
//   - A Kakao map (kakao.maps.Map) owns pan/zoom and renders the basemap tiles
//     into its own host div.
//   - A STANDALONE deck.gl Deck (not @deck.gl/react) renders the choropleth onto a
//     transparent canvas layered above the Kakao host (pointer-events:none, so
//     Kakao still receives the drag/zoom gestures).
//   - The two are kept PERFECTLY ALIGNED by deriving deck's {longitude,latitude,
//     zoom} from Kakao's ACTUAL visible bounds via WebMercatorViewport.fitBounds
//     (self-calibrating — no hardcoded Kakao-level↔zoom table). syncDeck() runs on
//     Kakao's bounds/center/zoom events AND in a requestAnimationFrame loop during
//     drag/zoom gestures so the overlay never lags the basemap.
//   - Picking (hover/drill/trend): the deck canvas can't receive pointer events (it's
//     pointer-events:none), so native listeners on the container call
//     deck.pickObject({x,y}) against the choropleth layer. Interaction model:
//       • hover (`mousemove`)      → tooltip ONLY
//       • right-click (`contextmenu`) → 추이(trend) card for the picked area (any level)
//       • double-click (`dblclick`)   → DRILL (gu→dong→grid)
//       • single-click (`click`)      → NOTHING (no trend, no drill — avoids the old
//                                        "trend pops up on a light touch" feel)
//     Kakao's own double-click zoom is disabled so the dblclick drills instead of
//     zooming the basemap.
//
// Why Kakao instead of MapLibre: Kakao tiles read as a familiar Korean basemap.
// Kakao's JS key is domain-restricted, so the SDK is loaded with no-referrer (see
// kakaoLoader.js + the <meta name="referrer"> in index.html).
//
// Color contract: getFillColor = colorScale(values[feature.properties[joinKey]]).
// Empty/no-data features → fully transparent (basemap shows through). The ONLY
// green in the map is the DATA fill (+ the Legend swatches); all chrome (borders,
// tooltip) stays ink/hairline — no green collisions.
//
// Selection emphasis: the drilled gu/dong gets a THICK INK outline (never green —
// green is reserved for the data).

import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { Deck, WebMercatorViewport } from '@deck.gl/core'
import { GeoJsonLayer, TextLayer } from '@deck.gl/layers'
// ClipExtension — clips a layer's geometry to a lng/lat box (clipBounds). The swipe
// split renders the SAME geo TWICE (A west of the divider, B east), each clipped to
// its half. Only the cheap clipBounds uniform changes per pan/zoom — the geo data
// ref stays stable so deck never re-tesselates the polygons mid-gesture.
import { ClipExtension } from '@deck.gl/extensions'
import './MapView.css'

import { loadKakao } from '../../lib/kakaoLoader.js'
import useStore from '../../store/useStore.js'
import { buildColorScale } from '../../lib/colorScale.js'
import { bboxOf } from '../../lib/bbox.js'
import { labelPointOf } from '../../lib/labelPoint.js'
import Legend from './Legend.jsx'
import MapTooltip from './MapTooltip.jsx'
import MapOverlay from './MapOverlay.jsx'
import CompareDivider from './CompareDivider.jsx'
import CompareBadges from './CompareBadges.jsx'
import InspectPanel from '../panel/InspectPanel.jsx'
import { fmtPeriod } from './formatPeriod.js'

// Seoul-centered initial Kakao camera (whole-city gu view). The drill viewport-fit
// (map.setBounds) reframes it on navigation; the deck overlay follows via syncDeck.
const SEOUL_CENTER = { lat: 37.5413, lng: 126.986 }
const INITIAL_KAKAO_LEVEL = 8

// ── Viewport-fit tightening ─────────────────────────────────────────────────
// Kakao's setBounds picks the smallest DISCRETE level where the bounds still fit
// inside the padded viewport; because levels step by ~2×, the chosen level can
// leave up to ~2× of linear margin (the area floats tiny in the middle — the
// default Seoul view suffered exactly this). Two levers tighten it:
//   1) tiny padding (vs the old 40px) so setBounds has less slack to round into.
//   2) a post-fit, CLIP-SAFE zoom-in loop that pulls the area up to fill the frame
//      as tightly as the discrete levels allow — WITHOUT ever clipping it.
const FIT_PADDING_PX = 8 // small px padding so polygons aren't flush to the edge
// Target fill: after setBounds we zoom in (LOWER Kakao level = MORE zoomed) one
// level at a time AS LONG AS the area would still occupy at most this fraction of
// the visible bounds in its BINDING (larger-occupancy) dimension. Each Kakao level
// ≈ HALVES the visible span (≈ doubles occupancy), so we PREDICT post-zoom occupancy
// as ~2× current and only commit the zoom when that prediction stays ≤ this cap —
// i.e. the area still fits with a hair of margin (never clipped). 0.92 lands the
// default Seoul gu view as tight as the integer levels permit: level 9 is the
// TIGHTEST level that frames all 25 구. VERIFIED EMPIRICALLY (2026-06, right panel
// collapsed by default → map is now ~1120px wide on a 1440 screen) that level 8 is
// STILL NOT usable even at this wider width: its visible span (≈0.406° lng / 0.230°
// lat) is SMALLER than Seoul's own bbox span (≈0.419° / 0.273°) in BOTH dimensions,
// so it blows Seoul up to ~103% of the frame width / ~119% of the height and clips
// whole 구 on EVERY edge (강서·강동 cut off W/E, 도봉·노원 top, 서초·강남 bottom) — predicted
// binding occ ~0.595×2 ≈ 1.19 > 0.92 so we correctly DON'T take it. Kakao's discrete
// levels leave NOTHING between 9 and 8 (fractional levels request non-existent tiles
// → broken basemap), so 9 is the biggest no-clip default possible; the wider map (a
// freed right panel) does NOT change the binding level here — it only leaves Seoul a
// touch looser in the frame (≈52% width / 59% height at lvl 9) which is the accepted
// price of never clipping a 구. On looser drill geos with room, the loop still
// tightens further where a level fits. Self-calibrates to container ASPECT via the
// binding dimension (square → width binds; landscape/short → height binds), so a
// narrow container never clips Seoul.
const TIGHTEN_TARGET_OCCUPANCY = 0.92
// Each discrete Kakao level step ≈ doubles linear occupancy; used to PREDICT the
// post-zoom occupancy before committing a (clip-safe) zoom-in.
const LEVEL_STEP_OCCUPANCY_FACTOR = 2
// Hard cap on tighten iterations — defensive bound so the loop can never spin even
// if Kakao's level stops decreasing (e.g. min-level clamp). Levels span ~1..14, and
// a single setBounds already lands near the fit, so 4 steps is ample headroom.
const MAX_TIGHTEN_STEPS = 4

// ── Default Seoul (all-구) extra zoom — INTENTIONAL CLIP ──────────────────────
// The clip-safe tighten loop above lands the all-Seoul gu default on Kakao level 9
// (~4km scale bar — the TIGHTEST no-clip level for all 25 구). The user wants the
// default Seoul view BIGGER, so after the no-clip fit we force ONE extra zoom-in
// (level 9 → 8, ~2km scale bar, ~2× bigger) ONLY for the gu/Seoul default. Kakao has
// no level between 9 and 8 (fractional levels request non-existent tiles → broken
// basemap), so level 8 is the next step up; the user accepts that the outer 구 edges
// clip (강북·도봉·노원 top, 강서 west, 금천·관악·서초 bottom, 강동 east — each loses a thin
// margin; central Seoul fills the frame). This is DETERMINISTIC: the tighten loop is
// a pure function of the geo bbox + container, always landing gu on 9, so subtracting
// this constant always lands the default on 8 on every fresh load.
//
// REVERT FLAG: set DEFAULT_GU_EXTRA_ZOOM = 0 to restore the no-clip level-9 default
// (the prior behavior — all 25 구 visible, ~4km scale bar, Seoul a touch loose).
const DEFAULT_GU_EXTRA_ZOOM = 1

// Per-level join + naming config. feature.properties[joinKey] → store code; the
// codes are TRIMMED defensively (backend strips, but geo props may carry padding).
const LEVEL_CFG = {
  gu: { geoKey: 'districtsGeo', joinKey: '구코드', nameKey: '구명' },
  dong: { geoKey: 'dongsGeo', joinKey: '행정동코드', nameKey: '행정동명' },
  grid: { geoKey: 'gridsGeo', joinKey: '격자코드', nameKey: null },
}

// Data-cell borders over the busy Kakao basemap. The old hairline (#ccc@0.75px) was
// too faint over tiles, so gu/dong cells get a darker, thicker line; grid keeps the
// medium gray at 1px (250m cells already read as distinct).
const GU_DONG_LINE_RGB = [70, 70, 70] // dark gray — clearly visible over Kakao tiles
const GU_DONG_LINE_WIDTH = 1.5 // thicker than the old 0.75px hairline
const GRID_LINE_RGB = [110, 110, 110] // medium gray — 250m grid cell separation
const GRID_LINE_WIDTH = 1.0
const INK_RGB = [0, 0, 0] // --ink #000 — selection emphasis (never green)
// Selection outline must stay clearly THICKER than the new stronger borders (1.5px)
// so the drilled gu/dong still stands out.
const SELECTION_LINE_WIDTH = 3.0

// Data-fill translucency: ~0.8 opacity so the Kakao basemap shows through a bit
// under the green choropleth (the only green in the map). No-data cells get alpha 0
// (fully transparent — basemap shows, no gray blocks).
const FILL_ALPHA = 205
// Grid level keeps the fill MORE transparent (~0.59) so the A-2 dong underlay
// (bold 동 boundaries + 행정동명 labels rendered BELOW/ABOVE the grid) reads
// through the green cells. gu/dong stay at the standard ~0.8.
const GRID_FILL_ALPHA = 150
const fillAlpha = (level) => (level === 'grid' ? GRID_FILL_ALPHA : FILL_ALPHA)
const TRANSPARENT = [0, 0, 0, 0] // fully transparent (fill OR line) for no-data cells

// 동 context underlay (A-2 whole-gu grid only): dark, bold boundary lines and dark
// readable labels — NEVER green (green is reserved for the data fill).
const DONG_LINE_RGB = [40, 40, 40] // very dark gray boundary line (구분선만 굵게)

// ── Multi-gu grid view overlay ───────────────────────────────────────────────
// The 구 boundary overlay (drawn UNDER the merged grids) uses an even bolder dark
// line than the 동 underlay so several 구 read as clearly separated regions. NOT
// green (green ≡ data fill). 구 labels are bigger than 동 labels (구 areas are large).
const GU_BOUNDARY_RGB = [40, 40, 40] // very dark — bold 구 경계선
const GU_BOUNDARY_HALO = [255, 255, 255, 235] // white halo under the dark 구 line (reads over any cell color)
const GU_BOUNDARY_WIDTH = 2.5 // thick 구 boundary (구 경계 굵게)
const MULTI_GU_LABEL_SIZE = 19 // 구명 a touch bigger than the gu-level label (large areas)

// Area NAME labels (시군구 / 행정동) over the choropleth. BOLD NanumSquare, dark text +
// thick white SDF halo so they read clearly over the Kakao basemap and the green
// cells — NEVER green.
const LABEL_RGB = [20, 20, 20] // very dark, readable 구명/행정동명 text (bumped darker for heft)
const LABEL_HALO = [255, 255, 255, 235] // thick white halo so labels stay legible
// Bumped sizes so the bold labels read clearly (gu fewer/bigger; dong denser).
const GU_LABEL_SIZE = 17 // 구명 a bit larger (fewer, bigger areas)
const DONG_LABEL_SIZE = 14 // 행정동명 slightly smaller (denser)
const A2_DONG_LABEL_SIZE = 15 // A-2 동 underlay labels
// Thicker white outline (vs the old 2) gives the labels visual heft/contrast.
const LABEL_OUTLINE_WIDTH = 3
// Bigger SDF buffer/radius so a THICK outline stays crisp at these sizes.
const LABEL_FONT_SETTINGS = { sdf: true, buffer: 8, radius: 12 }
// Bold NanumSquare once loaded; Inter fallback until document.fonts resolves (so the
// atlas never bakes the thin default — see fontReady gating below).
const LABEL_FONT_READY = 'NanumSquare, Inter, sans-serif'
const LABEL_FONT_FALLBACK = 'Inter, sans-serif'
const LABEL_FONT_WEIGHT = 700

// Level-aware DATA border (the choropleth outline for cells that have a value):
//   grid → medium gray @1px, so 250m cells read as distinct.
//   gu/dong → darker, thicker line so the boundary stays visible over Kakao tiles.
const dataLineRGB = (level) =>
  level === 'grid' ? GRID_LINE_RGB : GU_DONG_LINE_RGB
const dataLineWidth = (level) =>
  level === 'grid' ? GRID_LINE_WIDTH : GU_DONG_LINE_WIDTH

// ── Compare-mode clip bounds ─────────────────────────────────────────────────
// The two swipe halves clip to [W,S,splitLng,N] (A) and [splitLng,S,E,N] (B). W/S/
// E/N are a GENEROUS box around the data so the clip only ever cuts at splitLng
// (never at the data's own edges). We pad the geo bbox by this many degrees; if the
// bbox is unavailable we fall back to a wide Seoul-area box.
const CLIP_PAD_DEG = 1.0
const FALLBACK_BOUNDS = { W: 125.5, S: 37.0, E: 127.5, N: 38.0 } // wide Seoul box

// Compute the generous outer clip box from the active geo's bbox (padded), or a
// wide fallback. Returns {W,S,E,N}. Memoized on the geo identity by the caller.
function outerBoundsOf(geo) {
  const bb = bboxOf(geo)
  if (!bb) return { ...FALLBACK_BOUNDS }
  const [[minLng, minLat], [maxLng, maxLat]] = bb
  return {
    W: minLng - CLIP_PAD_DEG,
    S: minLat - CLIP_PAD_DEG,
    E: maxLng + CLIP_PAD_DEG,
    N: maxLat + CLIP_PAD_DEG,
  }
}

// Safe TRIM of a possibly-non-string property value.
const trim = (v) => (v == null ? '' : String(v).trim())

// Build TextLayer label data ({position, text}) for a level's geo: one INTERIOR
// anchor (pole of inaccessibility via labelPointOf) + name per feature. Skips
// features with no finite geometry / empty name. Used for both the gu/dong name
// labels and the A-2 동 underlay labels. The pole-of-inaccessibility anchor keeps
// names inside concave / river-split / multipart 동·구 (the bbox center used to
// drift them onto an edge or into the water).
function buildLabelData(geo, nameKey) {
  const feats = geo?.features
  if (!Array.isArray(feats)) return []
  const out = []
  for (const f of feats) {
    const position = labelPointOf(f)
    if (!position) continue
    const text = trim(f?.properties?.[nameKey])
    if (!text) continue
    out.push({ position, text })
  }
  return out
}

function MapView() {
  const level = useStore((s) => s.selection.level)
  const selGu = useStore((s) => s.selection.gu)
  const selDong = useStore((s) => s.selection.dong)
  const values = useStore((s) => s.data.values)
  const valuesByCode = useStore((s) => s.data.valuesByCode)
  const districtsGeo = useStore((s) => s.data.districtsGeo)
  const dongsGeo = useStore((s) => s.data.dongsGeo)
  const gridsGeo = useStore((s) => s.data.gridsGeo)
  const drillTo = useStore((s) => s.drillTo)
  // ── Inspect (우클릭 → 한 단계 아래 분포) ───────────────────────────────────────
  // A RIGHT-click opens the analysis section in the right panel (InspectPanel renders
  // there when data.inspect.target is set). The map only DISPATCHES inspectArea via the
  // native contextmenu handler; the panel reads/renders the result.
  const inspectArea = useStore((s) => s.inspectArea)
  const inspectTarget = useStore((s) => s.data.inspect.target) // gates the popup render
  // ── Compare (swipe) mode ────────────────────────────────────────────────────
  const compareMode = useStore((s) => s.compareMode)
  const valuesB = useStore((s) => s.data.valuesB)
  const valuesByCodeB = useStore((s) => s.data.valuesByCodeB)
  // ── Multi-gu grid view (여러 구 격자 비교) ─────────────────────────────────────
  // When `multiGus` is non-empty the map renders the MERGED multi-gu grids (one
  // Spectral choropleth over every selected 구's 250m cells) + a bold 구 경계/라벨
  // overlay, INSTEAD of the normal level view. multiGeo = union FeatureCollection;
  // multiValues/multiByCode = merged {격자코드:평균} / {격자코드:{…}} maps.
  const multiGus = useStore((s) => s.data.multiGrid.gus)
  const multiGeo = useStore((s) => s.data.multiGrid.geo)
  const multiValues = useStore((s) => s.data.multiGrid.values)
  const multiByCode = useStore((s) => s.data.multiGrid.valuesByCode)
  const multiBreakdown = useStore((s) => s.data.multiGrid.breakdown)
  const gridBreakdown = useStore((s) => s.data.gridBreakdown) // A-2 격자 동별 portion
  const isMultiGrid = multiGus.length > 0
  // Mode + A/B periods drive the dual-legend titles (and the A/B labels), so the
  // colors are clearly associated with each side + its period. Read here (compare-only
  // use, but hooks must run unconditionally).
  const mode = useStore((s) => s.selection.mode)
  const periodA = useStore((s) => s.selection.period)
  const periodB = useStore((s) => s.selectionB?.period)

  // ── Refs: container + Kakao map host + deck canvas + live instances ──────────
  const containerRef = useRef(null) // .mapview (positioning + native picking + measure)
  const hostRef = useRef(null) // Kakao basemap host div
  const canvasRef = useRef(null) // deck.gl overlay canvas
  const mapRef = useRef(null) // kakao.maps.Map instance
  const deckRef = useRef(null) // standalone Deck instance
  const kakaoRef = useRef(null) // the kakao namespace (for LatLng/LatLngBounds)
  const readyRef = useRef(false) // map+deck created and wired

  // Live-value mirrors for the mount-once native listeners (pickAt/mouseMove/contextmenu):
  // the mount effect runs once but must read the CURRENT level/cfg/valuesByCode/
  // drillTo. Written EVERY render inside an effect (strict ref rules forbid writing
  // refs during render), read only inside the (off-render) native handlers.
  const levelRef = useRef(level)
  const cfgRef = useRef(LEVEL_CFG.gu) // seeded; mirror effect sets the live cfg
  const valuesByCodeRef = useRef(valuesByCode)
  const drillToRef = useRef(drillTo)
  const inspectAreaRef = useRef(inspectArea) // live mirror for the native contextmenu handler
  const layersRef = useRef([]) // current layers (pushed once the map is ready)
  // Cross-effect call handles: the mount effect calls syncDeck()/fitToGeo() once the
  // map is ready (which may be AFTER those effects' first pass); these refs hold the
  // current implementations, updated by their owning effects below.
  const syncDeckRef = useRef(null)
  const fitToGeoRef = useRef(null)
  // What we last fitted (level + geo identity) so a recolor (same geo, new values)
  // never refits — only a real level/geo change does.
  const lastFit = useRef({ level: null, geo: null })

  // ── Compare (swipe) state ────────────────────────────────────────────────────
  // splitX — the divider's pixel x in the container (default = center, set once the
  // container is measured). viewState — a React MIRROR of deck's controlled camera,
  // updated by syncDeck so the clip layers' splitLng (= unproject(splitX)) tracks
  // pan/zoom. size — the measured container px (for the WebMercatorViewport unproject
  // + clamping splitX). draggingDividerRef — true while the handle is being dragged,
  // so the native picking mousemove early-returns (no deck pick during a drag) and
  // Kakao never pans (the divider stops/captures the pointer events).
  const [splitX, setSplitX] = useState(null) // null until measured → defaults to center
  const [viewState, setViewState] = useState(null) // {longitude,latitude,zoom}
  const [size, setSize] = useState({ width: 0, height: 0 })
  const draggingDividerRef = useRef(false)
  // suppressClickRef — survives PAST pointerup to swallow any synthesized click/dblclick
  // the browser may fire after a divider drag. draggingDividerRef is cleared in
  // onDividerUp (pointerup), but a synthesized event can bubble to the container's drill
  // (dblclick) listener AFTER pointerup — by then draggingDividerRef is already false, so
  // it could drill. This ref is set in onDividerDown and cleared in a 0ms timeout in
  // onDividerUp; the synthesized event dispatches synchronously (before the timeout), so
  // the guard catches it, then it clears so the NEXT real drill still works. (With drill
  // now on dblclick this is largely moot — a single synthesized click never drills — but
  // it stays as defense against a synthesized dblclick / double-tap on the divider.)
  const suppressClickRef = useRef(false)
  const compareModeRef = useRef(compareMode) // live mirror for the native handlers
  const splitXRef = useRef(splitX) // live mirror for side-aware picking
  const valuesByCodeBRef = useRef(valuesByCodeB) // live mirror for B-side tooltip
  // Multi-gu grid live mirrors: the mount-once picking closures must target the
  // 'choropleth-multi' layer + read the merged byCode for the tooltip when active.
  const isMultiGridRef = useRef(isMultiGrid)
  const multiByCodeRef = useRef(multiByCode)
  const multiBreakdownRef = useRef(multiBreakdown) // per-구 portions for the boundary-격자 tooltip
  const gridBreakdownRef = useRef(gridBreakdown) // A-2: per-동 portions for the boundary-격자 tooltip

  // Pick the GeoJSON matching the current level — OR the merged multi-gu grids when
  // the multi-grid view is active (it overrides the level view entirely).
  const geo = useMemo(() => {
    if (isMultiGrid) return multiGeo
    const key = LEVEL_CFG[level]?.geoKey
    return key === 'districtsGeo'
      ? districtsGeo
      : key === 'dongsGeo'
        ? dongsGeo
        : gridsGeo
  }, [isMultiGrid, multiGeo, level, districtsGeo, dongsGeo, gridsGeo])

  // Active join/name config. Multi-grid always joins on 격자코드 (grid cfg) regardless
  // of the (paused) normal level; otherwise the per-level config.
  const cfg = isMultiGrid ? LEVEL_CFG.grid : (LEVEL_CFG[level] ?? LEVEL_CFG.gu)

  // Build the quantile color scale(s) from the current values (rebuilt on change).
  //   multi-grid → the MERGED multi-gu values (one shared Spectral scale over all 구).
  //   compare    → A's values ONLY (scaleB below covers B). Each swipe half gets its
  //                OWN scale → each side spans its own data range (legends DIFFER; colors
  //                are NOT comparable across the divider — the chosen per-side tradeoff).
  //   normal     → just A's values.
  const scale = useMemo(
    () => buildColorScale(isMultiGrid ? multiValues : values),
    [isMultiGrid, multiValues, values],
  )
  // Compare-mode B-side scale — independent of A (per-side coloring). null otherwise.
  const scaleB = useMemo(
    () => (compareMode ? buildColorScale(valuesB) : null),
    [compareMode, valuesB],
  )

  // The code that is "selected" at THIS level (drilled-in target) — gets the ink
  // emphasis outline. gu level: the drilled gu; dong level: the drilled dong.
  // grid level is intentionally unhandled: grid features join on 격자코드, not
  // 행정동코드, so there's no in-level grid selection target.
  const selectedCode = level === 'dong' ? selDong : selGu

  // ── A-2 동 context underlay ─────────────────────────────────────────────────
  // ONLY on the whole-gu (시군구 기준) grid: level==='grid' AND no specific 동 drilled
  // in (dong===null) AND we have the gu's dongs geo loaded.
  const showDongUnderlay = level === 'grid' && selDong === null && !!dongsGeo

  // A-2 동 underlay labels: one anchor + 행정동명 per 동 feature. Memoized on the
  // dongsGeo IDENTITY so it isn't recomputed on every recolor/render.
  const dongLabelData = useMemo(
    () => buildLabelData(dongsGeo, LEVEL_CFG.dong.nameKey),
    [dongsGeo],
  )

  // CURRENT-LEVEL name labels (시군구 / 행정동) — shown on the gu + dong screens so the
  // user can see which area is which. Built from the active level's geo + its name
  // key (구명 / 행정동명) and memoized per-geo so it isn't recomputed on recolor.
  //   gu   → 구명 from districtsGeo
  //   dong → 행정동명 from dongsGeo
  //   grid → none (A-2 uses the 동 underlay labels; dong-scope grid is single-dong)
  const nameLabelData = useMemo(() => {
    if (level === 'gu') return buildLabelData(districtsGeo, LEVEL_CFG.gu.nameKey)
    if (level === 'dong') return buildLabelData(dongsGeo, LEVEL_CFG.dong.nameKey)
    return []
  }, [level, districtsGeo, dongsGeo])

  // ── Multi-gu grid overlay geo (구 경계 + 구명 라벨) ─────────────────────────────
  // The bold 구-boundary overlay + 구명 labels are built from districtsGeo FILTERED to
  // the selected `multiGus` (so only the chosen 구 get a boundary/label). Memoized on
  // districtsGeo identity + the gus set so it isn't recomputed on a recolor.
  const multiGusKey = multiGus.join(',') // stable string key for the memo deps
  const multiGuGeo = useMemo(() => {
    if (!isMultiGrid || !districtsGeo?.features) return null
    const set = new Set(multiGus.map((g) => String(g)))
    const features = districtsGeo.features.filter((f) =>
      set.has(trim(f?.properties?.[LEVEL_CFG.gu.joinKey])),
    )
    return { type: 'FeatureCollection', features }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiGrid, districtsGeo, multiGusKey])

  // 구명 labels for the selected 구 (one centroid anchor + 구명 per filtered feature).
  const multiGuLabelData = useMemo(
    () => buildLabelData(multiGuGeo, LEVEL_CFG.gu.nameKey),
    [multiGuGeo],
  )

  // ── Hover state → MapTooltip ────────────────────────────────────────────────
  const [hover, setHover] = useState(null)

  // ── Map-label font gating (NanumSquare Bold) ────────────────────────────────
  // deck.gl's TextLayer bakes glyphs into an SDF atlas using the BROWSER's font
  // rendering AT ATLAS-BUILD TIME. If NanumSquare isn't loaded when the atlas is
  // built, deck silently falls back to a thin default. So we gate fontFamily on a
  // fontReady flag: labels render in Inter until document.fonts resolves the bold
  // face, then fontReady flips → the label layers' memo recomputes (fontReady is in
  // its deps) → deck rebuilds the atlas with bold NanumSquare. Loads fast from local.
  const [fontReady, setFontReady] = useState(false)
  useEffect(() => {
    let alive = true
    const done = () => {
      if (alive) setFontReady(true)
    }
    // document.fonts may be unavailable in non-DOM/test envs — guard defensively.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      document.fonts.load('700 16px NanumSquare').then(done).catch(done)
    } else {
      done()
    }
    return () => {
      alive = false
    }
  }, [])

  // ── Compare-mode clip geometry ──────────────────────────────────────────────
  // Generous outer box around the data (memoized on geo identity — STABLE so the
  // clip layers' data ref never changes and deck only updates the splitLng uniform).
  const outerBounds = useMemo(() => outerBoundsOf(geo), [geo])

  // splitLng — the longitude at screen x=splitX. SCREEN-FIXED split: we unproject the
  // pixel column through the CURRENT viewport every render that viewState/splitX/size
  // changes, so the divider stays put in pixels while the map pans/zooms underneath
  // (the data slides; the cut line stays). null when the camera/size isn't ready yet.
  const splitLng = useMemo(() => {
    if (!compareMode || !viewState || !size.width || !size.height) return null
    const x = splitX == null ? size.width / 2 : splitX
    try {
      const vp = new WebMercatorViewport({
        width: size.width,
        height: size.height,
        ...viewState,
      })
      return vp.unproject([x, size.height / 2])[0]
    } catch {
      return null
    }
  }, [compareMode, viewState, size.width, size.height, splitX])

  // ── deck.gl layers ──────────────────────────────────────────────────────────
  // IDENTICAL layer-building to the prior MapLibre version. Only the OUTPUT route
  // changed: instead of a React <DeckGL layers={...}> prop, these are pushed to the
  // standalone deck via deck.setProps({ layers }) in the effect below. onHover/
  // onClick are removed from the choropleth (native picking handles them) since the
  // deck canvas is pointer-events:none and never gets deck's own pointer events.
  const layers = useMemo(() => {
    if (!geo) return []
    const isSelected = (f) =>
      selectedCode && trim(f.properties?.[cfg.joinKey]) === trim(selectedCode)
    // hasDataIn(vals, f): does this feature carry a finite value in the GIVEN values
    // object (A or B)? Computed once per feature and reused by the fill + line
    // accessors so they agree on no-data cells. The compare halves test their OWN
    // side's data independently (A west of the split, B east).
    const hasDataIn = (vals, f) => {
      const v = vals[trim(f.properties?.[cfg.joinKey])]
      return v !== null && v !== undefined && Number.isFinite(Number(v))
    }

    // Choropleth factory — builds a GeoJsonLayer over the SAME `geo` colored by the
    // given `vals` (A or B). Identical styling to the original single layer (level-
    // aware fill alpha, transparent no-data, level-aware borders, ink selection
    // outline). `clipBounds` (when provided) clips the layer to a lng/lat box via
    // ClipExtension — the swipe split passes A's [W,S,splitLng,N] and B's
    // [splitLng,S,E,N]. clipBounds is a plain layer PROP (a uniform), so deck diffs it
    // by value each render → a new array (splitLng changed) re-applies the cut with NO
    // re-tesselation (the geo data ref stays stable). No updateTrigger needed for it.
    const makeChoropleth = (idSuffix, vals, clipBounds, sc) =>
      new GeoJsonLayer({
        id: `choropleth-${idSuffix}`,
        data: geo,
        pickable: true,
        stroked: true,
        filled: true,
        lineWidthUnits: 'pixels',
        getFillColor: (f) => {
          if (!hasDataIn(vals, f)) return TRANSPARENT
          const [r, g, b] = sc.getColor(vals[trim(f.properties?.[cfg.joinKey])])
          return [r, g, b, fillAlpha(level)]
        },
        getLineColor: (f) => {
          if (isSelected(f)) return INK_RGB
          if (!hasDataIn(vals, f)) return TRANSPARENT
          return dataLineRGB(level)
        },
        getLineWidth: (f) => {
          if (isSelected(f)) return SELECTION_LINE_WIDTH
          if (!hasDataIn(vals, f)) return 0
          return dataLineWidth(level)
        },
        // ClipExtension only when a box is given (compare halves).
        ...(clipBounds ? { extensions: [new ClipExtension()], clipBounds } : {}),
        updateTriggers: {
          getFillColor: [vals, sc, level],
          getLineColor: [vals, sc, selectedCode, level],
          getLineWidth: [vals, selectedCode, level],
        },
      })

    // Non-compare → the single A layer (id 'choropleth-<level>', pickable). Compare →
    // TWO clipped layers: A west of the divider ('choropleth-A'), B east
    // ('choropleth-B'). Both share `geo` (stable ref) but use INDEPENDENT scales (A→scale,
    // B→scaleB), so each side spans its own range (colors are NOT cross-comparable). The
    // native pick layerId list (mount effect) includes all three ids so picking works.
    const choropleth = []
    if (compareMode && splitLng != null) {
      const { W, S, E, N } = outerBounds
      choropleth.push(makeChoropleth('A', values, [W, S, splitLng, N], scale))
      choropleth.push(makeChoropleth('B', valuesB, [splitLng, S, E, N], scaleB))
    } else {
      choropleth.push(makeChoropleth(level, values, null, scale))
    }

    // Bold NanumSquare once the face has loaded; Inter fallback until then so the
    // atlas never bakes the thin default. fontReady is in this memo's deps, so the
    // layers recompute (→ deck rebuilds the atlas) once the font resolves.
    const labelFontFamily = fontReady ? LABEL_FONT_READY : LABEL_FONT_FALLBACK

    // SDF TextLayer factory for area name labels (shared shape: BOLD NanumSquare,
    // dark text, thick white halo, Korean-capable atlas, non-pickable, sits ON TOP
    // for legibility). All three name layers (gu / dong / A-2 동 underlay) use it so
    // they stay consistent.
    const nameLabels = (id, data, size) =>
      new TextLayer({
        id,
        data,
        pickable: false,
        getPosition: (d) => d.position,
        getText: (d) => d.text,
        getSize: size,
        getColor: LABEL_RGB,
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        fontFamily: labelFontFamily,
        fontWeight: LABEL_FONT_WEIGHT, // deck.gl TextLayer accepts fontWeight (700 = bold)
        // 'auto' builds the glyph atlas dynamically from the data — REQUIRED for
        // Korean (구명/행정동명) since the default characterSet is ASCII-only.
        characterSet: 'auto',
        // SDF font enables the outline halo so labels read over basemap + green cells;
        // bigger buffer/radius keeps the THICK outline crisp at these sizes.
        fontSettings: LABEL_FONT_SETTINGS,
        outlineWidth: LABEL_OUTLINE_WIDTH,
        outlineColor: LABEL_HALO,
        // Rebuild the glyph atlas when the font flips from fallback → NanumSquare so
        // the labels snap to bold (the new fontFamily alone won't force an atlas rebuild).
        updateTriggers: { getText: [fontReady] },
      })

    // ── Multi-gu grid view (여러 구 격자 비교) ─────────────────────────────────────
    // When active, render ONLY: [구 경계 underlay] » [merged grid choropleth] » [구명
    // labels] — the normal level layers (and compare/A-2) are bypassed. The choropleth
    // is the MERGED multi-gu grids colored by the shared multiValues scale, with the
    // same grid styling (transparent no-data, medium-gray grid border) and id
    // 'choropleth-multi' (the pick layer list adds this id when multi is active). The
    // 구 boundary is bold dark (구 경계 굵게); the 구명 labels sit ON TOP, bigger than
    // dong labels. Nothing here is green except the data fill.
    if (isMultiGrid) {
      const layersOut = []
      // 1) Merged grid choropleth (BOTTOM) — Spectral fill over every selected 구's
      //    cells. grid styling (level forced to 'grid' via the multi cfg → GRID_FILL_ALPHA
      //    / GRID border). pickable so hover shows 격자코드 + 평균.
      layersOut.push(
        new GeoJsonLayer({
          id: 'choropleth-multi',
          data: geo, // the merged multiGeo
          pickable: true,
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          getFillColor: (f) => {
            if (!hasDataIn(multiValues, f)) return TRANSPARENT
            const [r, g, b] = scale.getColor(
              multiValues[trim(f.properties?.[cfg.joinKey])],
            )
            return [r, g, b, GRID_FILL_ALPHA]
          },
          getLineColor: (f) =>
            hasDataIn(multiValues, f) ? GRID_LINE_RGB : TRANSPARENT,
          getLineWidth: (f) => (hasDataIn(multiValues, f) ? GRID_LINE_WIDTH : 0),
          updateTriggers: {
            getFillColor: [multiValues, scale],
            getLineColor: [multiValues, scale],
            getLineWidth: [multiValues],
          },
        }),
      )
      // 2) 구 boundary — ON TOP of the grid so each 구's outline is clearly visible over
      //    the cells (the OLD order drew it UNDER the grid → the 558 cells buried it, so
      //    the two 구 read as one undifferentiated blob). Transparent fill keeps the grid
      //    showing through; a white halo line under the dark line makes the boundary pop
      //    over any cell color (red/blue alike). Non-pickable so it never steals hover.
      if (multiGuGeo) {
        layersOut.push(
          new GeoJsonLayer({
            id: 'multi-gu-boundary-halo',
            data: multiGuGeo,
            pickable: false,
            stroked: true,
            filled: false,
            getLineColor: GU_BOUNDARY_HALO, // white halo (under the dark line)
            lineWidthUnits: 'pixels',
            getLineWidth: GU_BOUNDARY_WIDTH + 3,
            lineWidthMinPixels: 4,
          }),
          new GeoJsonLayer({
            id: 'multi-gu-boundary',
            data: multiGuGeo,
            pickable: false,
            stroked: true,
            filled: false,
            getLineColor: GU_BOUNDARY_RGB, // 굵은 짙은 구 경계선
            lineWidthUnits: 'pixels',
            getLineWidth: GU_BOUNDARY_WIDTH,
            lineWidthMinPixels: 2,
          }),
        )
      }
      // 3) 구명 labels — ON TOP, bigger than dong labels (구 areas are large).
      layersOut.push(
        nameLabels('multi-gu-labels', multiGuLabelData, MULTI_GU_LABEL_SIZE),
      )
      return layersOut
    }

    // A-2 only: 동 boundary underlay + 행정동명 labels. Both pickable:false so they're
    // pure backdrop/overlay and never steal the grid's hover/click.
    const underlay = []
    const overlay = []
    if (showDongUnderlay) {
      // 동 boundary backdrop — rendered BELOW the grid. Fully transparent fill, bold
      // dark outline only (구분선만 굵게); NOT green (green ≡ data fill).
      underlay.push(
        new GeoJsonLayer({
          id: 'dong-underlay',
          data: dongsGeo,
          pickable: false,
          stroked: true,
          filled: true,
          getFillColor: TRANSPARENT, // 안은 완전 투명
          getLineColor: DONG_LINE_RGB, // 굵은 짙은 회색 경계선
          lineWidthUnits: 'pixels',
          getLineWidth: 2.5,
          lineWidthMinPixels: 2,
        }),
      )
      // 행정동명 labels — rendered ON TOP so they stay legible over the translucent
      // grid. Built via the shared SDF factory (white halo, dark text; NOT green).
      overlay.push(nameLabels('dong-labels', dongLabelData, A2_DONG_LABEL_SIZE))
    }

    // CURRENT-LEVEL name labels (시군구 / 행정동) on the gu + dong screens, rendered ON
    // TOP of the choropleth so they're readable above the green cells. Mutually
    // exclusive with the A-2 case (grid uses the 동 underlay labels above instead).
    if (level === 'gu') overlay.push(nameLabels('gu-labels', nameLabelData, GU_LABEL_SIZE))
    else if (level === 'dong')
      overlay.push(nameLabels('dong-name-labels', nameLabelData, DONG_LABEL_SIZE))

    // Bottom→top: [dong underlay (A-2)] » choropleth(s) » [name labels]. Labels last
    // so they sit ON TOP and stay legible above the data fill. In compare mode the
    // name labels stay UN-clipped (shared context over both halves). `choropleth` is
    // an array (1 layer non-compare, 2 clipped layers in compare) → spread it.
    return [...underlay, ...choropleth, ...overlay]
  }, [
    geo,
    level,
    scale,
    values,
    cfg.joinKey,
    selectedCode,
    showDongUnderlay,
    dongsGeo,
    dongLabelData,
    nameLabelData,
    // Compare deps: rebuild the two clipped layers when compare toggles, B's values
    // change, or the split longitude moves (pan/zoom/drag). outerBounds is geo-stable.
    compareMode,
    valuesB,
    scaleB,
    splitLng,
    outerBounds,
    // fontReady: flips false→true once NanumSquare Bold loads → recompute the layers
    // (new fontFamily + atlas-rebuild updateTrigger) so labels snap to bold NanumSquare.
    fontReady,
    // Multi-gu grid deps: rebuild when the view toggles, the merged values change
    // (recolor on filter), or the 구 boundary/label geo changes (gus set change).
    isMultiGrid,
    multiValues,
    multiGuGeo,
    multiGuLabelData,
  ])

  // ── Kakao → Deck sync (ALIGNMENT-CRITICAL) ──────────────────────────────────
  // Read Kakao's CURRENT visible bounds and set the deck viewState to EXACTLY span
  // the same lng/lat box at the same pixel size → the choropleth is rendered in the
  // identical Web-Mercator projection Kakao shows. This self-calibrates: whatever
  // Kakao does (any level, any center), deck mirrors its actual bounds. Defined as a
  // ref-held callback so the event listeners + rAF loop share one stable function.
  useEffect(() => {
    syncDeckRef.current = () => {
      const map = mapRef.current
      const deck = deckRef.current
      const el = containerRef.current
      if (!map || !deck || !el) return
      const b = map.getBounds()
      if (!b) return
      const sw = b.getSouthWest()
      const ne = b.getNorthEast()
      const width = el.clientWidth
      const height = el.clientHeight
      if (!width || !height) return
      const bounds = [
        [sw.getLng(), sw.getLat()],
        [ne.getLng(), ne.getLat()],
      ]
      let vp
      try {
        vp = new WebMercatorViewport({ width, height }).fitBounds(bounds, {
          padding: 0,
        })
      } catch {
        return // never crash the overlay on a bad bounds; leave it as-is
      }
      const next = {
        longitude: vp.longitude,
        latitude: vp.latitude,
        zoom: vp.zoom,
      }
      deck.setProps({ viewState: next })

      // ── Compare-mode mirror ─────────────────────────────────────────────────
      // Mirror the camera + container size into React state ONLY in compare mode, so
      // the clip layers' splitLng (= unproject(splitX) through this viewport) tracks
      // the pan/zoom. We skip this entirely when compare is off (no clip layers → no
      // need) and skip a setState when the value is unchanged (avoid render churn).
      if (!compareModeRef.current) return
      setViewState((prev) =>
        prev &&
        prev.longitude === next.longitude &&
        prev.latitude === next.latitude &&
        prev.zoom === next.zoom
          ? prev
          : next,
      )
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      )
    }
  }, [])

  // ── Mount: load Kakao SDK, create the map + standalone Deck, wire sync + picking ─
  useEffect(() => {
    // Capture the container node ONCE up front so the cleanup uses the same element
    // the listeners were attached to (the ref may change before cleanup runs).
    const el = containerRef.current
    let cancelled = false
    // rAF id + listener handles captured in closures for cleanup.
    let rafId = null
    const listeners = [] // [{ type, handler }]
    let mouseMove, mouseDblClick, mouseContextMenu, mouseLeave

    loadKakao()
      .then((kakao) => {
        if (cancelled) return
        const hostEl = hostRef.current
        const canvasEl = canvasRef.current
        if (!hostEl || !canvasEl || !el) return

        kakaoRef.current = kakao

        // 1) Kakao basemap — owns pan/zoom; renders tiles into hostEl.
        //    disableDoubleClickZoom: a double-click DRILLS the choropleth (native
        //    dblclick listener below) instead of zooming the basemap. We disable ONLY
        //    the dbl-click ZOOM (not disableDoubleClick, which would also suppress the
        //    DOM dblclick event the drill listener needs). Pan + wheel-zoom still work.
        const map = new kakao.maps.Map(hostEl, {
          center: new kakao.maps.LatLng(SEOUL_CENTER.lat, SEOUL_CENTER.lng),
          level: INITIAL_KAKAO_LEVEL,
          disableDoubleClickZoom: true,
        })
        mapRef.current = map

        // 2) Standalone Deck on the overlay canvas — controller:false because Kakao
        //    drives the camera; deck's viewState is fed from Kakao's bounds.
        const deck = new Deck({
          canvas: canvasEl,
          width: '100%',
          height: '100%',
          controller: false,
          // Seed with a sane viewState; syncDeck() overwrites it immediately below.
          viewState: {
            longitude: SEOUL_CENTER.lng,
            latitude: SEOUL_CENTER.lat,
            zoom: 9,
          },
          layers: [],
        })
        deckRef.current = deck
        if (import.meta.env.DEV && typeof window !== 'undefined') window.__deck = deck

        const syncDeck = () => syncDeckRef.current?.()

        // 3) Align once now that both exist.
        syncDeck()

        // 4) rAF loop for SMOOTH tracking during continuous gestures. Kakao's
        //    discrete events alone can lag the overlay mid-drag/zoom; the loop calls
        //    syncDeck every frame while a gesture is active so the choropleth stays
        //    glued to the tiles. Started on dragstart/zoom_start, stopped on
        //    dragend/zoom_changed/idle.
        const tick = () => {
          syncDeck()
          rafId = requestAnimationFrame(tick)
        }
        const startLoop = () => {
          if (rafId == null) rafId = requestAnimationFrame(tick)
        }
        const stopLoop = () => {
          if (rafId != null) {
            cancelAnimationFrame(rafId)
            rafId = null
          }
          // One final sync to land EXACTLY on the settled bounds.
          syncDeck()
        }

        // 5) Wire Kakao events → syncDeck (+ gesture loop). bounds/center/zoom cover
        //    programmatic moves (setBounds) and the discrete end-of-gesture state.
        const add = (type, handler) => {
          kakao.maps.event.addListener(map, type, handler)
          listeners.push({ type, handler })
        }
        add('bounds_changed', syncDeck)
        add('center_changed', syncDeck)
        add('zoom_changed', () => {
          stopLoop() // a discrete zoom step settled → resync and end any loop
        })
        add('dragstart', startLoop)
        add('dragend', stopLoop)
        add('zoom_start', startLoop)
        add('idle', stopLoop)

        // 6) Native picking on the container (deck canvas is pointer-events:none).
        //    Kakao still receives the gesture events on its own host; we DON'T
        //    preventDefault, so drag/zoom keep working underneath.
        // pickAt reads level via the ref so it always targets the CURRENT choropleth
        // layer id(s). Non-compare: the single level-suffixed layer. Compare: BOTH
        // 'choropleth-A' and 'choropleth-B' (the side under the cursor wins the pick).
        const pickAt = (clientX, clientY) => {
          const d = deckRef.current
          if (!d) return null
          const r = el.getBoundingClientRect()
          const x = clientX - r.left
          const y = clientY - r.top
          // Multi-grid view → the single merged 'choropleth-multi' layer. Else compare
          // → both halves; else the normal level-suffixed layer.
          const layerIds = isMultiGridRef.current
            ? ['choropleth-multi']
            : compareModeRef.current
              ? ['choropleth-A', 'choropleth-B']
              : [`choropleth-${levelRef.current}`]
          return d.pickObject({ x, y, radius: 1, layerIds })
        }

        mouseMove = (e) => {
          // While dragging the divider, the divider owns the pointer — do NOT pick
          // (no flickering hover under the moving split), and clear any stale hover.
          if (draggingDividerRef.current) {
            setHover(null)
            return
          }
          const info = pickAt(e.clientX, e.clientY)
          const f = info?.object
          if (!f) {
            setHover(null)
            return
          }
          // All live values via refs — the mount closure runs once but must reflect
          // the CURRENT level/cfg/valuesByCode (changed by drills/filters).
          const liveCfg = cfgRef.current
          const code = trim(f.properties?.[liveCfg.joinKey])
          const name = liveCfg.nameKey
            ? (f.properties?.[liveCfg.nameKey] ?? null)
            : null
          // x/y are container-relative (MapTooltip positions absolutely in .mapview).
          const r = el.getBoundingClientRect()
          const cursorX = e.clientX - r.left
          // Multi-grid → merged byCode. Else side-aware in compare (cursorX < splitX →
          // A, else B). Else the normal A byCode.
          let rec
          if (isMultiGridRef.current) {
            rec = multiByCodeRef.current?.[code]
          } else if (compareModeRef.current) {
            const sx = splitXRef.current == null ? r.width / 2 : splitXRef.current
            rec =
              cursorX < sx
                ? valuesByCodeRef.current?.[code]
                : valuesByCodeBRef.current?.[code]
          } else {
            rec = valuesByCodeRef.current?.[code]
          }
          // Boundary-격자 portion breakdown for the tooltip, normalized to [{label, 평균}]:
          //   multi-gu view → per-구 split (구명);  A-2 (구 전체 격자) → per-동 split (행정동명).
          // Only when the cell actually straddles 2+ regions (the store keeps only those).
          let breakdown
          let breakdownTitle
          if (isMultiGridRef.current) {
            const bd = multiBreakdownRef.current?.[code]
            if (Array.isArray(bd) && bd.length >= 2) {
              breakdown = bd.map((b) => ({ label: b.구명, 평균: b.평균 }))
              breakdownTitle = '겹친 구별'
            }
          } else {
            const bd = gridBreakdownRef.current?.[code]
            if (Array.isArray(bd) && bd.length >= 2) {
              breakdown = bd.map((b) => ({ label: b.행정동명, 평균: b.평균 }))
              breakdownTitle = '겹친 동별'
            }
          }
          setHover({
            x: cursorX,
            y: e.clientY - r.top,
            code,
            name,
            // 평균 생활인구 — the single displayed metric (day mode carries only {평균}).
            평균: rec?.평균,
            breakdown,
            breakdownTitle,
          })
        }
        // Resolve the picked feature → {code, name} for the trend card, or null. name
        // = the level's name prop (구명/행정동명) when present, else the code (grids have
        // no name → 격자코드 is the title). Shared by the click + contextmenu handlers.
        const trendTargetAt = (clientX, clientY) => {
          const info = pickAt(clientX, clientY)
          const f = info?.object
          if (!f) return null
          const liveCfg = cfgRef.current
          const code = trim(f.properties?.[liveCfg.joinKey])
          if (!code) return null
          const name = liveCfg.nameKey
            ? (trim(f.properties?.[liveCfg.nameKey]) || code)
            : code
          return { code, name }
        }
        // SINGLE-click → NOTHING. The trend is RIGHT-click only (see mouseContextMenu)
        // and the drill is DOUBLE-click only (see mouseDblClick); a single click must
        // do nothing so the trend never pops up on a light touch / accidental tap while
        // panning. We attach no `click` listener at all — this comment documents the
        // deliberate absence.

        // RIGHT-click → open the area's trend (월별 추이) IMMEDIATELY. preventDefault
        // suppresses the browser context menu. Works at ANY level (구/동/격자).
        // Guards: skip during/just-after a divider drag, and ignore an empty-map
        // right-click (no feature under the cursor).
        mouseContextMenu = (e) => {
          e.preventDefault()
          if (draggingDividerRef.current || suppressClickRef.current) return
          const target = trendTargetAt(e.clientX, e.clientY)
          if (!target) return
          // Multi-grid cells are 격자, so the trend is at the 'grid' level (not the
          // paused selection level, which stays 'gu').
          const lvl = isMultiGridRef.current ? 'grid' : levelRef.current
          inspectAreaRef.current?.(lvl, target.code, target.name)
        }

        // Drill on DOUBLE-click (not single click): a single click — including an
        // accidental tap while panning the map — must NEVER drill. The dblclick DOM
        // event still fires on the container because we disabled only Kakao's
        // double-click ZOOM (disableDoubleClickZoom), not the dblclick event itself.
        mouseDblClick = (e) => {
          // A divider drag isn't a map double-click. draggingDividerRef covers the drag
          // itself; suppressClickRef covers a synthesized click/dblclick fired after a
          // divider pointerup. (Both are component-scope refs the mount-once closure reads.)
          if (draggingDividerRef.current || suppressClickRef.current) return
          // Multi-grid view PAUSES the normal drill — its cells are 격자 (deepest), and
          // the single-scope drill flow is bypassed while several 구 are shown together.
          if (isMultiGridRef.current) return
          const info = pickAt(e.clientX, e.clientY)
          const f = info?.object
          if (!f) return
          const code = trim(f.properties?.[cfgRef.current.joinKey])
          if (!code) return
          const lvl = levelRef.current
          if (lvl === 'gu') drillToRef.current('dong', code)
          else if (lvl === 'dong') drillToRef.current('grid', code)
          // level === 'grid': deepest — do not drill further.
        }
        mouseLeave = () => setHover(null)

        el.addEventListener('mousemove', mouseMove)
        el.addEventListener('dblclick', mouseDblClick)
        el.addEventListener('contextmenu', mouseContextMenu)
        el.addEventListener('mouseleave', mouseLeave)

        readyRef.current = true
        // Push the current layers + fit the very first geo (effects below also run,
        // but the map may have become ready AFTER those effects' first pass).
        deck.setProps({ layers: layersRef.current })
        fitToGeoRef.current?.()

        // Dev-only test visibility: expose the live Kakao map + deck so Playwright/
        // manual checks can verify alignment (project the same lng/lat through both).
        // Mirrors the store's window.__store hook; DEV-gated, never shipped.
        if (import.meta.env.DEV && typeof window !== 'undefined') {
          window.__map = map
          window.__deck = deck
        }
      })
      .catch((err) => {
        // Surface a console error; the loading/error veil is store-driven, but a
        // Kakao SDK failure is a hard map failure worth logging.
        console.error('[MapView] Kakao init failed:', err)
      })

    return () => {
      cancelled = true
      readyRef.current = false
      if (rafId != null) cancelAnimationFrame(rafId)
      if (el) {
        if (mouseMove) el.removeEventListener('mousemove', mouseMove)
        if (mouseDblClick) el.removeEventListener('dblclick', mouseDblClick)
        if (mouseContextMenu) el.removeEventListener('contextmenu', mouseContextMenu)
        if (mouseLeave) el.removeEventListener('mouseleave', mouseLeave)
      }
      const kakao = kakaoRef.current
      const map = mapRef.current
      if (kakao && map) {
        for (const { type, handler } of listeners) {
          kakao.maps.event.removeListener(map, type, handler)
        }
      }
      if (deckRef.current) {
        deckRef.current.finalize()
        deckRef.current = null
      }
      mapRef.current = null
    }
    // Mount-once: the map/deck are created a single time. Live values used inside
    // the listeners (level/cfg/valuesByCode/drillTo/layers) are read through refs
    // so we never need to recreate the map on a data/selection change.
  }, [])

  // ── Mirror live render values into refs (for the mount-once native listeners) ─
  // The mount effect runs once; its closures (pickAt/mouseMove/contextmenu) must see
  // the CURRENT level/cfg/valuesByCode/drillTo/layers without re-subscribing. We
  // write the refs inside an effect (NOT during render — strict ref rules) that runs
  // on every relevant change. The handlers read these refs off-render, so a stale
  // closure still sees fresh data.
  useEffect(() => {
    levelRef.current = level
    cfgRef.current = cfg
    valuesByCodeRef.current = valuesByCode
    drillToRef.current = drillTo
    inspectAreaRef.current = inspectArea
    layersRef.current = layers
    compareModeRef.current = compareMode
    splitXRef.current = splitX
    valuesByCodeBRef.current = valuesByCodeB
    isMultiGridRef.current = isMultiGrid
    multiByCodeRef.current = multiByCode
    multiBreakdownRef.current = multiBreakdown
    gridBreakdownRef.current = gridBreakdown
  }, [level, cfg, valuesByCode, drillTo, inspectArea, layers, compareMode, splitX, valuesByCodeB, isMultiGrid, multiByCode, multiBreakdown, gridBreakdown])

  // ── Compare-mode camera/size seed ────────────────────────────────────────────
  // When compare turns ON, the clip layers need viewState + size IMMEDIATELY (the
  // syncDeck mirror otherwise only fires on the next Kakao event). Seed both from the
  // live container + a forced syncDeck so splitLng is computable on the first frame.
  // Also (re)center the divider when compare turns on if it isn't placed yet.
  useEffect(() => {
    if (!compareMode) return
    const el = containerRef.current
    if (el?.clientWidth && el?.clientHeight) {
      setSize((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight },
      )
      setSplitX((prev) => (prev == null ? el.clientWidth / 2 : prev))
    }
    // Force a sync now (mirrors viewState since compareModeRef may not be set yet —
    // set it directly so the mirror inside syncDeck runs on this very call).
    compareModeRef.current = true
    syncDeckRef.current?.()
  }, [compareMode])

  // ── Push layers to the standalone deck whenever they change ─────────────────
  useEffect(() => {
    if (deckRef.current) deckRef.current.setProps({ layers })
  }, [layers])

  // ── Viewport fit on level/geo change (drill / scope toggle) — via KAKAO ──────
  // When the ACTIVE geojson for the current level changes (drill in/out or grid
  // scope toggle), fit the KAKAO camera to that layer's bbox; the Kakao→Deck sync
  // then realigns the overlay. We key the fit on BOTH the level AND the geo OBJECT
  // IDENTITY (reference), NOT on values/filters: a filter change recolors the SAME
  // geo object (identity unchanged) so we must NOT refit (that would yank the camera
  // back on every slider nudge). The `lastFit` ref records what we successfully
  // fitted so a recolor (new `values`, same geo object) never refits.
  const fitToGeo = useCallback(() => {
    if (!readyRef.current) return // map not created yet → mount effect will call us
    if (!geo) return // active layer not loaded yet → skip (effect re-fires on arrival)
    // Fit key: normally the (level, geo-object) pair. In MULTI-GRID mode `geo`
    // (multiGeo) is REBUILT on every refetch (incl. filter recolors), so keying on its
    // identity would refit on each filter nudge. Instead key on the GUS SET string —
    // so only a 구-set change refits; a filter recolor (same gus) keeps the camera.
    const fitLevel = isMultiGrid ? 'multi' : level
    const fitGeoKey = isMultiGrid ? multiGusKey : geo
    if (lastFit.current.level === fitLevel && lastFit.current.geo === fitGeoKey) return
    const kakao = kakaoRef.current
    const map = mapRef.current
    const el = containerRef.current
    if (!kakao || !map || !el) return
    // Container not yet measured (first mount before layout / hidden): a fit now would
    // round against a 0-px frame and mis-zoom. DON'T record lastFit — bail so the
    // ResizeObserver (which fires once the box is sized) retries the fit.
    if (!el.clientWidth || !el.clientHeight) return

    const bounds = bboxOf(geo)
    if (!bounds) return // degenerate/empty geometry → nothing to fit
    const [[minLng, minLat], [maxLng, maxLat]] = bounds
    // Kakao LatLng is (lat, lng) — latitude FIRST.
    const kb = new kakao.maps.LatLngBounds(
      new kakao.maps.LatLng(minLat, minLng),
      new kakao.maps.LatLng(maxLat, maxLng),
    )
    // Record BEFORE setBounds (it fires bounds_changed → syncDeck) so the sync that
    // follows doesn't see a stale lastFit and re-trigger. Stored under the FIT KEY
    // (gus-set string in multi mode, geo object otherwise).
    lastFit.current = { level: fitLevel, geo: fitGeoKey }
    // Small px padding (vs the old 40px) so setBounds rounds to a TIGHTER level.
    map.setBounds(kb, FIT_PADDING_PX, FIT_PADDING_PX, FIT_PADDING_PX, FIT_PADDING_PX)

    // Post-fit tightening (CLIP-SAFE, DETERMINISTIC): setBounds lands on a discrete
    // level that often leaves a big margin (the area floats tiny — the default Seoul
    // gu view suffered exactly this, sitting ~24% looser than it could). We then zoom
    // IN one level at a time (LOWER Kakao level = MORE zoomed) as long as the area's
    // BINDING (larger-occupancy) dimension would still fit. Each level ≈ HALVES the
    // visible span, so we PREDICT the post-zoom binding occupancy as ~2× the current
    // and only commit the zoom when that prediction stays ≤ TIGHTEN_TARGET_OCCUPANCY
    // (≤1 → never clips). This is a pure function of the geo bbox + the measured
    // container, so the same level/geo always lands on the SAME framing (no first-load
    // heuristic variance), and the binding-dimension test self-calibrates to the
    // container's aspect (square → width binds; landscape/short → height binds) so a
    // narrow container never clips the area. setBounds/setLevel are synchronous, so
    // map.getBounds() reflects the just-fitted view on each iteration.
    const seoulSpanLng = maxLng - minLng
    const seoulSpanLat = maxLat - minLat
    for (let i = 0; i < MAX_TIGHTEN_STEPS; i++) {
      const vb = map.getBounds()
      if (!vb) break
      const vsw = vb.getSouthWest()
      const vne = vb.getNorthEast()
      const visLng = vne.getLng() - vsw.getLng()
      const visLat = vne.getLat() - vsw.getLat()
      if (!(visLng > 0) || !(visLat > 0)) break
      const occLng = seoulSpanLng / visLng
      const occLat = seoulSpanLat / visLat
      // BINDING dim = whichever currently fills more of the frame; it hits the cap
      // first, so testing it guarantees neither dim clips after the zoom.
      const bindingOcc = Math.max(occLng, occLat)
      const predictedOcc = bindingOcc * LEVEL_STEP_OCCUPANCY_FACTOR
      if (predictedOcc > TIGHTEN_TARGET_OCCUPANCY) break // one more zoom would overshoot
      const lvl = map.getLevel()
      if (lvl <= 1) break // already at the tightest Kakao level
      map.setLevel(lvl - 1) // Kakao: lower level = zoom IN
      if (map.getLevel() === lvl) break // level didn't change (min-level clamp) → stop
    }

    // ── Default Seoul extra zoom (INTENTIONAL CLIP) ───────────────────────────
    // The clip-safe loop above leaves the all-구 default on level 9 (no-clip). For the
    // gu/Seoul default ONLY (not multi-grid, not a dong/grid drill — those keep their
    // own no-clip fits), pull ONE extra level tighter (9 → 8, ~2× bigger, ~2km scale
    // bar) so the user's preferred BIGGER Seoul lands deterministically. Outer 구 edges
    // clip by a thin margin — the accepted trade for a bigger central Seoul. Guarded by
    // DEFAULT_GU_EXTRA_ZOOM (0 = revert to the no-clip level 9).
    if (!isMultiGrid && level === 'gu' && DEFAULT_GU_EXTRA_ZOOM > 0) {
      for (let i = 0; i < DEFAULT_GU_EXTRA_ZOOM; i++) {
        const lvl = map.getLevel()
        if (lvl <= 1) break // already at the tightest Kakao level
        map.setLevel(lvl - 1) // 9 → 8 (zoom IN one step)
        if (map.getLevel() === lvl) break // min-level clamp → stop
      }
    }
    // setBounds/setLevel emit bounds_changed/zoom_changed → syncDeck realigns the overlay.
  }, [geo, level, isMultiGrid, multiGusKey])

  // Expose the current fitToGeo to the mount effect (which may need to call the FIRST
  // fit if the map became ready AFTER this effect's first pass: SDK load vs. geo
  // arrival race). Written in an effect, read off-render in the mount closure.
  useEffect(() => {
    fitToGeoRef.current = fitToGeo
  }, [fitToGeo])

  // Refit whenever the geo/level identity changes (the guard inside skips recolors).
  useEffect(() => {
    fitToGeo()
  }, [fitToGeo])

  // ── Resize: relayout Kakao + resync deck ────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const map = mapRef.current
      if (map) map.relayout() // Kakao must recompute tile layout on container resize
      syncDeckRef.current?.() // deck canvas auto-sizes (100%); refit to new px box
      // If the FIRST viewport-fit was skipped because the container was unmeasured at
      // mount, retry it now that the box is sized. The lastFit guard inside makes this
      // a no-op once the current level/geo has been fitted (no refit on plain resize).
      fitToGeoRef.current?.()
      // Compare: keep `size` fresh and clamp the divider inside the new width so the
      // split + clip stay aligned to the resized box.
      if (compareModeRef.current) {
        const w = el.clientWidth
        const h = el.clientHeight
        if (w && h) {
          setSize((prev) =>
            prev.width === w && prev.height === h ? prev : { width: w, height: h },
          )
          setSplitX((prev) =>
            prev == null ? w / 2 : Math.min(Math.max(prev, 0), w),
          )
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Divider drag handlers (pointer-capture based) ────────────────────────────
  // The divider lives in the .mapview container's pixel space. On pointer down we set
  // draggingDividerRef (so the native picking mousemove early-returns and a drag isn't
  // read as a map click) and capture the pointer; on move we clamp splitX to [0,width];
  // on up we release. stopPropagation on the pointer events keeps Kakao from panning.
  const onDividerDown = useCallback((e) => {
    draggingDividerRef.current = true
    // Arm the click-suppressor so any synthesized click/dblclick after this drag's
    // pointerup is swallowed by the container's drill (dblclick) guard.
    suppressClickRef.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.stopPropagation()
  }, [])
  const onDividerMove = useCallback((e) => {
    if (!draggingDividerRef.current) return
    e.stopPropagation()
    const el = containerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    setSplitX(Math.min(Math.max(x, 0), r.width))
  }, [])
  const onDividerUp = useCallback((e) => {
    if (!draggingDividerRef.current) return
    draggingDividerRef.current = false
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    e.stopPropagation()
    // Clear the click-suppressor on the NEXT tick. Any synthesized click/dblclick from
    // this drag dispatches SYNCHRONOUSLY (before this 0ms timeout), so the dblclick (drill)
    // and contextmenu (trend) guards still see suppressClickRef===true and swallow it; the
    // timeout then clears it so a subsequent REAL double-click drills normally.
    setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }, [])

  // Effective divider x (default = center of the measured box until first placed).
  const dividerX = splitX == null ? (size.width ? size.width / 2 : null) : splitX

  return (
    <div className="mapview" ref={containerRef}>
      {/* Kakao basemap host — fills the container, receives pan/zoom gestures. */}
      <div className="mapview__kakao" ref={hostRef} />
      {/* deck.gl overlay canvas — above the basemap, transparent, click-through so
          Kakao still gets the gestures. Picking is done via native listeners. */}
      <canvas className="mapview__deck" ref={canvasRef} />

      {/* Legend(s). Compare mode → render TWICE: bottom-LEFT for A (scale), bottom-RIGHT
          for B (scaleB). Each side uses its OWN independent Spectral bins, so the two
          legends differ (each half spans its own data range; colors are not comparable
          across the divider). Non-compare → the single bottom-left legend as before. */}
      {compareMode ? (
        <>
          <Legend
            bins={scale.bins}
            position="left"
            title="A · 평균 생활인구"
            subtitle={fmtPeriod(mode, periodA)}
          />
          <Legend
            bins={scaleB?.bins ?? []}
            position="right"
            title="B · 평균 생활인구"
            subtitle={fmtPeriod(mode, periodB)}
          />
        </>
      ) : (
        <Legend bins={scale.bins} />
      )}
      <MapTooltip hover={hover} />

      {/* Compare (swipe) chrome — only in compareMode. Large A/B period labels, each
          centered in its half of the split (reposition as the divider moves) + the
          draggable vertical divider. All ink/hairline (green-free). */}
      {compareMode && dividerX != null && (
        <CompareBadges splitX={dividerX} width={size.width} />
      )}
      {compareMode && dividerX != null && (
        <CompareDivider
          x={dividerX}
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
        />
      )}

      {/* 우클릭 분석 POPUP — 한 단계 아래 분포(구→행정동 비교 / 동→격자 파이 / 격자→추이).
          floating over the map, dismissible. (전체 구 추이는 패널의 AllGuTrendCard로 상시.) */}
      {inspectTarget && <InspectPanel />}

      {/* Always-mounted loading/error veil (toggled by opacity, never remounted). */}
      <MapOverlay />
    </div>
  )
}

export default MapView
