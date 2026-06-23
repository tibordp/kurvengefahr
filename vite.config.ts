import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// `@wasm` points at the wasm-pack output (crate/pkg). The `.wasm` itself is loaded
// at runtime via a `?url` import + `init()`, so no extra wasm plugin is needed.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@wasm': path.resolve(__dirname, 'crate/pkg'),
    },
  },
})
