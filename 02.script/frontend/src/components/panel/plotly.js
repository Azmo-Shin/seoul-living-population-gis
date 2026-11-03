// Single place where Plotly is wired into React. We have `plotly.js-dist` (a UMD
// build) installed, NOT the full `plotly.js` graph that react-plotly.js pulls in
// by default — so we use the FACTORY to bind our dist build explicitly. This keeps
// Plotly wired ONCE; CompareBar/HourlyLine import the ready `Plot` from here.
//
// Import shape (verified to build under Vite 8):
//   - `plotly.js-dist` is UMD (module.exports = factory()) → Vite's CJS interop
//     gives the Plotly object as the DEFAULT import.
//   - `react-plotly.js/factory` is CJS (exports.default = plotComponentFactory) →
//     default import is the factory function.
import factoryImport from 'react-plotly.js/factory'
import Plotly from 'plotly.js-dist'
import './plotly-overrides.css'

// CJS interop quirk: `react-plotly.js/factory` is CJS (exports.default = fn). Vite's
// DEV optimizer (esbuild) can double-wrap it so the default import is an OBJECT
// `{ default: fn }`, while the PROD build (rolldown) hands back the function directly.
// Unwrap defensively so BOTH paths resolve to the factory function (verified: dev
// gave `typeof default === 'object'` with `default.default` being the function).
const createPlotlyComponent =
  typeof factoryImport === 'function' ? factoryImport : factoryImport?.default

// Fail loud if a future Vite/plotly upgrade changes the CJS-default interop: this
// errors at import with a clear message instead of passing `undefined` to the
// factory and failing cryptically at render.
if (typeof createPlotlyComponent !== 'function') {
  throw new Error('react-plotly.js/factory interop changed: expected a function, got ' + typeof createPlotlyComponent)
}

// The bound React component. Used as <Plot data={...} layout={...} config={...} />.
const Plot = createPlotlyComponent(Plotly)

// ── Shared monochrome layout/config defaults ─────────────────────────────────
// Green is the DATA encoding only (the map owns it; here a single green series on
// CompareBar/HourlyLine). Everything else is ink/mute/stone. Flat chrome: no
// gridline clutter, tight margins, flat hoverlabel (the HTML modebar is flattened
// via plotly-overrides.css since it's DOM, not SVG).
// '#1a1a1a' = --body token (Plotly needs a JS literal; not --ink which is #000)
export const BODY = '#1a1a1a'
export const MUTE = '#757575'
export const STONE = '#898989'
export const GREEN = '#76b900'
export const HAIRLINE = '#ccc'
export const CANVAS = '#fff'
export const FONT_FAMILY = 'Inter, Arial, sans-serif'

// Base layout shared by both charts. Spread then override per-chart.
export const baseLayout = {
  paper_bgcolor: CANVAS,
  plot_bgcolor: CANVAS,
  font: { family: FONT_FAMILY, color: BODY, size: 12 },
  // Monochrome fallback for any incidental multi-series (our charts are single
  // green series, but this keeps Plotly from reaching for its default palette).
  colorway: [BODY, MUTE, STONE],
  margin: { l: 8, r: 16, t: 8, b: 32 },
  showlegend: false,
  hoverlabel: {
    bgcolor: CANVAS,
    bordercolor: HAIRLINE,
    font: { family: FONT_FAMILY, color: BODY, size: 12 },
    align: 'left',
  },
  // Avoid a default transition that would otherwise animate on every recolor.
  autosize: true,
}

// Minimal, flat config. No modebar clutter. Resize is wired via the `useResizeHandler`
// prop on <Plot> (relayouts to CONTAINER size on WINDOW resize, which suits the flex
// panel) — so we do NOT also set `responsive: true` here to avoid double-wiring the
// same concern. useResizeHandler only catches WINDOW resize; CONTAINER-only resizes
// are additionally covered by the ResizeObserver in ResponsivePlot.jsx (Task 9 §B),
// which CompareBar/HourlyLine render instead of the bare <Plot>.
export const baseConfig = {
  displayModeBar: false,
  displaylogo: false,
  // Lock down accidental interactions that don't fit a compact panel chart.
  scrollZoom: false,
  doubleClick: false,
}

export default Plot
