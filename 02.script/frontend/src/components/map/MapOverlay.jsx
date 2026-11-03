// MapOverlay — the ALWAYS-MOUNTED loading/error veil for the choropleth. A prior
// reviewer required this be permanently mounted (toggled by opacity/visibility),
// NOT conditionally mounted: conditionally remounting would let the map measure an
// unsized container and break the viewport-fit. So it lives here at all times and
// only its opacity/pointer-events change.
//
// States (priority: error > loading > idle):
//   loading → a subtle translucent veil + green Spinner ("불러오는 중…"). The
//             choropleth stays visible underneath (the veil is light, dims slightly).
//   error   → the error message (error token) centered on a translucent panel.
//   idle    → fully transparent, pointer-events:none (never intercepts the map).
//
// Green budget: the Spinner is the only green here (sanctioned). Error = error
// token; veil/panel chrome stays canvas/hairline (no shadows, flat/angular).
import useStore from '../../store/useStore.js'
import Spinner from '../ui/Spinner.jsx'

function MapOverlay() {
  const loading = useStore((s) => s.data.loading)
  const error = useStore((s) => s.data.error)

  // error wins over loading (a failed fetch also clears loading, but be explicit).
  const mode = error ? 'error' : loading ? 'loading' : 'idle'
  const active = mode !== 'idle'

  return (
    <div
      className={`map-overlay${active ? ' is-active' : ''}`}
      // aria-hidden when idle so SR users don't hit an empty live region.
      aria-hidden={!active}
    >
      {mode === 'loading' && (
        <div className="map-overlay__box" role="status">
          {/* decorative: this box's role="status" already announces loading, so the
              Spinner must not be a second nested live region. */}
          <Spinner size={28} thickness={3} decorative />
          <span className="t-body-sm" style={{ color: 'var(--mute)' }}>
            불러오는 중…
          </span>
        </div>
      )}

      {mode === 'error' && (
        <div className="map-overlay__box" role="alert">
          <span className="t-body-strong" style={{ color: 'var(--error)' }}>
            {error}
          </span>
          <span className="t-caption-sm" style={{ color: 'var(--mute)' }}>
            잠시 후 다시 시도해 주세요.
          </span>
        </div>
      )}
    </div>
  )
}

export default MapOverlay
