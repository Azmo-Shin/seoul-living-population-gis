import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Pre-bundle the React trio + zustand up front and dedupe React to the single
  // root copy. Without this, Vite can re-run dep optimization mid-session when a
  // newly-imported dep (zustand) is discovered, briefly serving mixed optimized
  // chunks → a transient "Invalid hook call / useCallback of null" in dev.
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand'] },
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    // host:true binds 0.0.0.0 so the dev server is reachable on the LAN
    // (e.g. http://0.0.0.0:9600). The /api + /healthz proxy still runs
    // server-side on this host → reaches the backend at localhost:9601 with no
    // CORS issue (the browser sees same-origin requests to :9600).
    host: true,
    port: 9600,
    proxy: {
      '/api': { target: 'http://localhost:9601', changeOrigin: true },
      // /healthz is NOT under /api; the store's precheck needs it proxied too.
      '/healthz': { target: 'http://localhost:9601', changeOrigin: true },
    },
  },
})
