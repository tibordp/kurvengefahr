import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'

// `@wasm` points at the wasm-pack output (crate/pkg). The `.wasm` itself is loaded
// at runtime via a `?url` import + `init()`, so no extra wasm plugin is needed.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // Generate the full favicon / app-icon set from one source SVG and inject the head links.
      pwaAssets: { image: 'public/logo.svg' },
      manifest: {
        name: 'Kurvengefahr',
        short_name: 'Kurvengefahr',
        description:
          'Browser CAM for pen plotters — handwriting, text, shapes, generative art, SVG/DXF/STL import; preview the exact toolpath and plot as G-code or live over USB.',
        theme_color: '#ffffff',
        background_color: '#f4f4f5',
        display: 'standalone',
        start_url: '/',
      },
      workbox: {
        // Precache the app shell so it boots offline. The WASM (~80 KB) and Inter fonts are small
        // enough to precache; the ~7 MB model blob is deliberately excluded here and runtime-cached
        // below so install stays light and the model is only fetched on first generation.
        globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.bin'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'kg-model',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@wasm': path.resolve(__dirname, 'crate/pkg'),
    },
  },
})
