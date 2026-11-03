import ModeTabs from '../controls/ModeTabs.jsx'

// TopBar — the merged dark top chrome bar (~56px). Combines what used to be the
// UtilityBar (title + data-period) and the PrimaryNav (green wordmark + ModeTabs)
// into ONE flat dark row:
//   LEFT  : green "생활인구" wordmark (the ONE allowed solid-green chrome element)
//           followed by the "서울 생활인구 대시보드" title.
//   RIGHT : store-wired 일/주/월 ModeTabs + the data-period text.
// Dark surface, on-dark text, flat, radius 0. The right cluster wraps / the period
// hides on very narrow widths (CSS) so the ModeTabs stay usable. `period` is static
// for now; the data-period source is preserved as a prop (Task 3 → /api/meta/range).
function TopBar({ period = '데이터 기간: 2024-01 ~ 2026-06' }) {
  return (
    <header
      className="chrome-bar top-bar"
      style={{
        height: '56px',
        flex: '0 0 56px',
        background: 'var(--surface-dark)',
        color: 'var(--on-dark)',
        justifyContent: 'space-between',
        gap: 'var(--sp-md)',
      }}
    >
      {/* LEFT: green wordmark + title (wordmark first, then the dashboard title). */}
      <div className="top-bar__brand">
        <span
          className="nav-wordmark t-heading-md"
          style={{ color: 'var(--green)' }}
        >
          생활인구
        </span>
        <span className="top-bar__title t-body-strong">서울 생활인구 대시보드</span>
      </div>

      {/* RIGHT: ModeTabs (일/주/월) + the data-period text. */}
      <div className="top-bar__util">
        <ModeTabs />
        <span
          className="top-bar__period t-caption-sm"
          style={{ color: 'var(--on-dark-mute)' }}
        >
          {period}
        </span>
      </div>
    </header>
  )
}

export default TopBar
