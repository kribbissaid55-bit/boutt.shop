import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional subdirectory deploy (e.g. https://shop.ma/app/) — set VITE_BASE=/app/
// in the shell before `npm run build`. Default `/` covers the common case where
// the frontend is served at the domain root.
const base = process.env.VITE_BASE || '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    // Sourcemaps ship the un-minified source alongside the bundle — great for
    // debugging staging, but they double the deploy artifact and leak
    // implementation details. Off by default; flip to `true` for staging.
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['.loca.lt', '.trycloudflare.com', '.ngrok-free.app', '.ngrok.io', '.pinggy-free.link', '.pinggy.io'],
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
