// CompareDivider — the draggable vertical split line for compare (swipe) mode.
//
// A full-height 2px ink hairline at `left:x` (pixels from the container's left) with
// a centered grabbable handle. Rendered OVER the map (z above the deck canvas). The
// line + handle are pointer-events:auto so they catch the drag; the rest of the map
// stays interactive (the deck canvas itself is pointer-events:none — Kakao gets the
// gestures). MapView owns the drag math (pointer capture + clamping + stopPropagation
// so Kakao never pans during a drag); this component is presentational + forwards the
// pointer handlers.
//
// Green-budget: the divider + handle are INK / white hairline ONLY — never green
// (green is reserved for the choropleth data encoding).

const LINE_COLOR = 'var(--ink)' // 2px ink line — clearly visible over the basemap
const HANDLE_HIT = 28 // ≥24px square hit area for the grab handle (touch-friendly)

/**
 * @param {{
 *   x: number,                       // divider x in container pixels
 *   onPointerDown: (e)=>void,
 *   onPointerMove: (e)=>void,
 *   onPointerUp: (e)=>void,
 * }} props
 */
function CompareDivider({ x, onPointerDown, onPointerMove, onPointerUp }) {
  return (
    <div
      className="compare-divider"
      style={{
        position: 'absolute',
        left: x,
        top: 0,
        bottom: 0,
        width: 0,
        // z above the deck canvas(1)/Legend(2)/Tooltip(3); below the busy veil(4).
        zIndex: 3,
        pointerEvents: 'none', // the wrapper is inert; the line/handle below opt in
      }}
      aria-hidden="false"
    >
      {/* The visible 2px line, centered on x (translateX -1px). White hairline edges
          via box-shadow-free double-border would add chrome; a single ink line with a
          thin white outline keeps it legible over both halves without a shadow. */}
      <div
        style={{
          position: 'absolute',
          left: -1,
          top: 0,
          bottom: 0,
          width: 2,
          background: LINE_COLOR,
          // Thin white side-hairlines so the ink line reads over dark tiles too. No
          // box-shadow (design rule); these are crisp 1px borders, not a blur.
          borderLeft: '1px solid rgba(255,255,255,0.85)',
          borderRight: '1px solid rgba(255,255,255,0.85)',
          pointerEvents: 'auto', // the line itself is grabbable
          cursor: 'ew-resize',
          touchAction: 'none', // let pointer events drive the drag (no scroll/zoom)
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Defense-in-depth: keep the post-drag synthesized click from bubbling to the
        // container's map-click listener at all (the MapView suppressClickRef guard is
        // the primary fix; this stops it from ever reaching the drill handler).
        onClick={(e) => e.stopPropagation()}
      />
      {/* The grab handle — a small flat ink pill at vertical center, ≥24px hit area. */}
      <button
        type="button"
        aria-label="비교 분할선 이동"
        style={{
          position: 'absolute',
          left: -HANDLE_HIT / 2,
          top: '50%',
          transform: 'translateY(-50%)',
          width: HANDLE_HIT,
          height: HANDLE_HIT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          border: 'none',
          background: 'transparent',
          pointerEvents: 'auto',
          cursor: 'ew-resize',
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(e) => e.stopPropagation()}
      >
        {/* The visible knob: a flat ink chip with a white hairline ring, 2px radius
            (design rule), with a ‹›-style double chevron hint. No shadow. */}
        <span
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: 'var(--ink)',
            color: 'var(--on-dark)',
            border: '1px solid rgba(255,255,255,0.9)',
            borderRadius: 'var(--r)',
            fontSize: 11,
            lineHeight: 1,
            letterSpacing: '-1px',
            userSelect: 'none',
          }}
        >
          ‹›
        </span>
      </button>
    </div>
  )
}

export default CompareDivider
