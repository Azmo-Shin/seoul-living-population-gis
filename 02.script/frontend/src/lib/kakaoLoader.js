// kakaoLoader.js — injects the Kakao Maps JS SDK exactly once and resolves with
// the ready `window.kakao` namespace. A pure DOM side-effect loader (no React,
// no store): MapView awaits it on mount before creating the Kakao map.
//
// no-referrer is LOAD-BEARING here. The Kakao JS key is domain-restricted; on an
// HTTP origin a normal request 401s ("domain mismatched"). But when NO Referer is
// sent, Kakao serves the SDK + tiles fine. So the injected <script> sets
// referrerPolicy='no-referrer' (and index.html sets <meta name="referrer"
// content="no-referrer"> to strip Referer from the tile/image requests too).
//
// The module-level `_promise` memoizes the load so repeated calls (React 19
// StrictMode double-mount, remounts) reuse the single in-flight/settled promise
// rather than injecting a second <script>.

const KAKAO_APPKEY = import.meta.env.VITE_KAKAO_APPKEY  // .env 에 VITE_KAKAO_APPKEY=<카카오 JS 키>

let _promise = null

/**
 * Load the Kakao Maps SDK once. Resolves with the `window.kakao` namespace after
 * `kakao.maps.load(...)` has run (i.e. the maps API is fully ready). Subsequent
 * calls return the same promise.
 * @returns {Promise<typeof window.kakao>}
 */
export function loadKakao() {
  if (_promise) return _promise
  _promise = new Promise((resolve, reject) => {
    // Already present (e.g. HMR re-import after the SDK loaded) → just wait for ready.
    if (window.kakao && window.kakao.maps) {
      window.kakao.maps.load(() => resolve(window.kakao))
      return
    }
    const s = document.createElement('script')
    // Strip the Referer so Kakao's domain check is bypassed (verified working).
    s.referrerPolicy = 'no-referrer'
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_APPKEY}&autoload=false`
    s.onload = () => window.kakao.maps.load(() => resolve(window.kakao))
    s.onerror = () => reject(new Error('Kakao SDK load failed'))
    document.head.appendChild(s)
  })
  return _promise
}

export default loadKakao
