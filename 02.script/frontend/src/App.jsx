import { useEffect, useState, useCallback, useRef } from 'react'
import './App.css'
import TopBar from './components/chrome/TopBar.jsx'
import Breadcrumb from './components/chrome/Breadcrumb.jsx'
import FilterRail from './components/controls/FilterRail.jsx'
import MapView from './components/map/MapView.jsx'
import Panel from './components/panel/Panel.jsx'
import useStore from './store/useStore.js'

// App shell: two chrome rows (merged dark TopBar + soft Breadcrumb) + a three-column
// body region. The dark TopBar merges the old UtilityBar + PrimaryNav into one row
// (wordmark+title left, ModeTabs+period right). Task 4 fills the left rail with the
// filter controls (FilterRail); Task 5 fills the center with the deck.gl choropleth
// map (MapView); Task 7 fills the right column with the KPI / chart Panel.
// Task 3's data layer kicks off the store's init() once on mount (range +
// districts + gu geo + initial query). Rendering loading/error states is Task 8.
//
// Task 9 (responsive): ≥1024 keeps the 3-column inline layout. <1024 collapses the
// filter rail into a LEFT OVERLAY DRAWER (toggled by the "필터" button in the
// breadcrumb bar) and stacks the KPI panel BELOW the map (shell-body switches
// row→column via CSS). The drawer is an overlay (position:fixed) so toggling it
// never reflows the map/panel — avoiding needless deck.gl/Plotly container resizes.
// JS state only tracks drawer open/closed; CSS media queries decide inline-vs-drawer.
function App() {
  const init = useStore((s) => s.init)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Right KPI/chart panel collapse state (default COLLAPSED — user preference for more
  // map width). NOTE: collapsing widens the map but Seoul is height-bound at Kakao
  // level 9, so the extra width becomes horizontal margin (Seoul ~52% width); the toggle
  // re-opens the panel (Seoul ~76% width) when a tighter frame is wanted.
  // Right panel collapse state lives in the store (so inspectArea can auto-open it on a
  // 우클릭 분석 — the panel is default-collapsed for map width; the toggle flips it).
  const panelOpen = useStore((s) => s.panelOpen)
  const togglePanel = useStore((s) => s.togglePanel)
  // Right panel WIDTH (px) — user-resizable via the .shell-resize handle. Charts reflow
  // (ResponsivePlot's ResizeObserver). Default 360 (320 on small desktops). Clamped so
  // neither panel nor map collapses. Applied as the --panel-w CSS var on .shell-body.
  const [panelWidth, setPanelWidth] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth <= 1280 ? 320 : 360,
  )
  const [resizing, setResizing] = useState(false)
  const onResizeDown = useCallback(
    (e) => {
      e.preventDefault()
      setResizing(true)
      const startX = e.clientX
      const startW = panelWidth
      const maxW = Math.min(760, Math.max(360, window.innerWidth - 460)) // keep map usable
      const onMove = (ev) => {
        const next = startW + (startX - ev.clientX) // drag LEFT → wider panel
        setPanelWidth(Math.max(280, Math.min(maxW, next)))
      }
      const onUp = () => {
        setResizing(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [panelWidth],
  )
  const drawerRef = useRef(null) // the <aside> dialog (for focus-trap queries)
  const closeBtnRef = useRef(null) // focused on open
  const openerRef = useRef(null) // element to return focus to on close (the toggle)

  useEffect(() => {
    init()
  }, [init])

  // Close on Escape — only meaningful while the drawer is open on a narrow screen,
  // but harmless otherwise (the rail is inline ≥1024 and the class is a no-op there).
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  // Focus management: on open, remember the opener (the 필터 toggle the user clicked)
  // and move focus into the drawer (the close button). On close, return focus to the
  // opener. Returning focus is the documented a11y contract for a modal dialog.
  useEffect(() => {
    if (!drawerOpen) return
    // document.activeElement at open time is the toggle that triggered it.
    openerRef.current = document.activeElement
    closeBtnRef.current?.focus?.()
    return () => {
      openerRef.current?.focus?.()
    }
  }, [drawerOpen])

  // Body-scroll-lock while the drawer is open (narrow-screen overlay). Restore the
  // previous overflow value on close/unmount so we never clobber other callers.
  useEffect(() => {
    if (!drawerOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [drawerOpen])

  const openDrawer = useCallback(() => setDrawerOpen(true), [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // Close-on-wide: if the viewport crosses to ≥1024 while the drawer is open, the rail
  // goes inline (toggle hidden) — close the drawer so drawerOpen doesn't stay stale-true.
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = (e) => {
      if (e.matches) closeDrawer()
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [closeDrawer])

  // Focus trap: while open, keep Tab/Shift+Tab inside the drawer's focusable elements
  // (close button + FilterRail controls). Cheap wrap-around; no-op if nothing focusable.
  const onDrawerKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return
    const root = drawerRef.current
    if (!root) return
    const focusables = root.querySelectorAll(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"])'
    )
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else if (document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }, [])

  return (
    <div className="shell">
      {/* Row 1: merged dark bar (wordmark+title left, ModeTabs+period right). */}
      <TopBar />
      {/* Row 2: soft breadcrumb bar. Carries the breadcrumb trail (left) + the
          비교 모드 and 격자 toggles (right), plus the narrow-screen drawer toggle. */}
      <Breadcrumb onOpenFilters={openDrawer} filtersOpen={drawerOpen} />

      <div
        className={`shell-body${panelOpen ? '' : ' panel-collapsed'}`}
        style={{ '--panel-w': `${panelWidth}px` }}
      >
        {/* Backdrop: only rendered/visible while the drawer is open on a narrow
            screen (CSS hides it ≥1024). Clicking it closes the drawer. */}
        <div
          className={`shell-backdrop${drawerOpen ? ' is-open' : ''}`}
          onClick={closeDrawer}
          aria-hidden="true"
        />

        <aside
          ref={drawerRef}
          id="filter-drawer"
          className={`shell-rail${drawerOpen ? ' is-open' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label="필터"
          onKeyDown={onDrawerKeyDown}
        >
          {/* Drawer header — only visible when the rail is a drawer (<1024). Holds the
              close affordance. Inline ≥1024 it's hidden via CSS. */}
          <div className="shell-rail__drawer-head">
            <span className="t-caption" style={{ color: 'var(--ink)' }}>
              필터
            </span>
            <button
              ref={closeBtnRef}
              type="button"
              className="shell-rail__close t-body-strong"
              onClick={closeDrawer}
              aria-label="필터 닫기"
            >
              ✕
            </button>
          </div>
          <FilterRail />
        </aside>

        <section className="shell-map">
          <MapView />
        </section>
        {/* Collapse/expand toggle for the right KPI/chart panel. ONE button pinned at
            the map↔panel boundary (≥1024: vertically centered on the right edge of the
            map; <1024: a thin horizontal handle between the stacked map and panel). Its
            chevron flips with state: › collapses (panel open), ‹ re-expands (collapsed).
            Always reachable — when collapsed it stays pinned to the map's right edge. */}
        <button
          type="button"
          className="shell-panel-toggle"
          onClick={togglePanel}
          aria-expanded={panelOpen}
          aria-label="패널 접기/펼치기"
          aria-controls="kpi-panel"
        >
          <span aria-hidden="true">{panelOpen ? '›' : '‹'}</span>
        </button>
        {/* Drag-to-resize handle on the panel's left edge (≥1024, panel open). Widens/
            narrows the panel; the map flexes + the charts reflow (ResponsivePlot). */}
        {panelOpen && (
          <div
            className={`shell-resize${resizing ? ' is-dragging' : ''}`}
            onPointerDown={onResizeDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="패널 너비 조절"
          />
        )}
        <aside id="kpi-panel" className="shell-kpi">
          <Panel />
        </aside>
      </div>
    </div>
  )
}

export default App
