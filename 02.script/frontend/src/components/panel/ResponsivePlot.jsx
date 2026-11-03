// ResponsivePlot — thin wrapper around the bound Plotly <Plot> that hardens chart
// resizing against CONTAINER-only size changes (Task 9 §B).
//
// Why: Plotly's `useResizeHandler` only listens to WINDOW resize. Most of this app's
// breakpoint changes (the 1024 row↔column switch, the map-height change, the panel
// moving from the right column to the full-width bottom stack) DO ride on a window
// resize, so useResizeHandler alone already covers them. But a ResizeObserver makes
// the charts correct regardless of WHAT changed the container (future reflows, the
// panel's right-column→bottom width jump, font swaps, scrollbar appearance), at
// negligible cost. We keep useResizeHandler too (belt + suspenders) and additionally
// observe the wrapper element, calling Plotly.Plots.resize on the inner .js-plotly-plot
// node whenever its box changes. rAF-debounced so a burst of observer callbacks during
// a drag/transition collapses to one relayout per frame.
import { useEffect, useRef } from 'react'
import Plotly from 'plotly.js-dist'
import Plot from './plotly.js'

function ResponsivePlot(props) {
  const wrapRef = useRef(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || typeof ResizeObserver === 'undefined') return

    const resize = () => {
      // Plotly renders a .js-plotly-plot node inside; resize THAT (Plotly's own
      // element), not our wrapper. Guard: it may not exist on the very first tick.
      const gd = wrap.querySelector('.js-plotly-plot')
      if (gd) {
        try {
          Plotly.Plots.resize(gd)
        } catch {
          // Never let a transient resize race (mid-teardown node) crash the panel.
        }
      }
    }

    const ro = new ResizeObserver(() => {
      // Debounce to one relayout per animation frame (drawer/transition bursts).
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(resize)
    })
    ro.observe(wrap)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [])

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <Plot {...props} />
    </div>
  )
}

export default ResponsivePlot
