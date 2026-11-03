// Breadcrumb — 48px soft strip marking the dark→light surface transition. Store-
// connected (Task 6): builds the drill trail from `selection` + name lookups and
// lets ancestor crumbs navigate UP.
//
//   gu level                 → 서울                         (서울 is current)
//   dong level               → 서울 › 강남구                (서울 clickable→resetScope)
//   grid level (dong drilled) → 서울 › 강남구 › 역삼1동       (서울, 강남구 clickable)
//   grid level (gu-scope A-2)  → 서울 › 강남구 › 격자          (서울, 강남구 clickable)
//
// The CURRENT (last) crumb is plain text; ancestors are real <button>s. Chrome stays
// GREEN-FREE — clickable crumbs use ink/hairline, separators stay --mute.
//
// The breadcrumb row also hosts, RIGHT-ALIGNED in the same bar: the 비교 모드 toggle
// (<CompareToggle compact/>) and the 격자 toggle (<GridToggle compact/>, which self-
// hides unless a 구 is selected). Both are ink/hairline (green-free), compact-sized.
import useStore from '../../store/useStore.js'
import CompareToggle from '../controls/CompareToggle.jsx'
import GridToggle from '../controls/GridToggle.jsx'

// A clickable ancestor crumb (real button, keyboard-accessible). Ink text, no green,
// no chrome fill — a hairline underline on hover signals "navigates up".
function CrumbButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="t-caption"
      style={{
        appearance: 'none',
        background: 'none',
        border: 'none',
        padding: 0,
        margin: 0,
        font: 'inherit',
        textTransform: 'inherit',
        letterSpacing: 'inherit',
        color: 'var(--body)',
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationColor: 'var(--hairline)',
        textUnderlineOffset: '3px',
      }}
    >
      {label}
    </button>
  )
}

function Breadcrumb({ onOpenFilters, filtersOpen = false }) {
  const level = useStore((s) => s.selection.level)
  const gu = useStore((s) => s.selection.gu)
  const dong = useStore((s) => s.selection.dong)
  const districts = useStore((s) => s.data.districts)
  const dongs = useStore((s) => s.data.dongs)
  const drillTo = useStore((s) => s.drillTo)
  const resetScope = useStore((s) => s.resetScope)

  // Name lookups (fall back to the raw code if meta isn't loaded yet — never crashes).
  const guName =
    gu != null
      ? (districts?.find((d) => String(d.구코드) === String(gu))?.구명 ?? gu)
      : null
  const dongName =
    dong != null
      ? (dongs?.find((d) => String(d.행정동코드) === String(dong))?.행정동명 ??
        dong)
      : null

  // Build the trail. Each crumb: { label, onClick|null }. onClick === null → current
  // (non-clickable) crumb. Ancestors carry an up-navigation handler.
  const items = []
  // 서울 — clickable unless it's the only crumb (gu level with no drill).
  const seoulIsCurrent = level === 'gu' && gu == null
  items.push({ label: '서울', onClick: seoulIsCurrent ? null : resetScope })

  if (gu != null) {
    // 강남구 — current at dong level; clickable (→ back to that gu's dong screen)
    // at grid level (whether dong-scope or gu-scope A-2 grid).
    const guIsCurrent = level === 'dong'
    items.push({
      label: guName,
      onClick: guIsCurrent ? null : () => drillTo('dong', gu),
    })
  }

  if (level === 'grid') {
    // Deepest crumb (always current/non-clickable): the 행정동명 when a dong is
    // drilled, or the generic '격자' label for the gu-scope (A-2) grid view.
    items.push({ label: dong != null ? dongName : '격자', onClick: null })
  }

  return (
    <nav
      aria-label="breadcrumb"
      className="chrome-bar t-caption"
      style={{
        height: '48px',
        flex: '0 0 48px',
        background: 'var(--surface-soft)',
        color: 'var(--body)',
        gap: 'var(--sp-sm)',
      }}
    >
      {/* LEFT cluster: optional narrow-screen filter toggle + the breadcrumb trail.
          marginRight:auto pushes the RIGHT cluster (toggles) to the far edge. */}
      <div
        className="bc-trail"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-sm)',
          minWidth: 0,
          marginRight: 'auto',
        }}
      >
        {/* Narrow-screen filter-drawer toggle. Hidden ≥1024 via CSS (.bc-filter-toggle);
            on <1024 it's the only way to reach the (drawer-collapsed) filter rail. */}
        {onOpenFilters && (
          <button
            type="button"
            className="bc-filter-toggle t-button-sm"
            onClick={onOpenFilters}
            aria-label="필터 열기"
            aria-expanded={filtersOpen}
            aria-controls="filter-drawer"
          >
            필터
          </button>
        )}
        {items.map((item, i) => (
          <span
            key={`${item.label}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--sp-sm)',
            }}
          >
            {i > 0 && (
              <span aria-hidden="true" style={{ color: 'var(--mute)' }}>
                ›
              </span>
            )}
            {item.onClick ? (
              <CrumbButton label={item.label} onClick={item.onClick} />
            ) : (
              <span aria-current="location">{item.label}</span>
            )}
          </span>
        ))}
      </div>

      {/* RIGHT cluster: 비교 모드 + 격자 toggles (compact, ink/hairline, green-free).
          GridToggle self-hides unless a 구 is selected. Wraps below on narrow widths. */}
      <div
        className="bc-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-sm)',
          flexShrink: 0,
        }}
      >
        <CompareToggle compact />
        <GridToggle compact />
      </div>
    </nav>
  )
}

export default Breadcrumb
