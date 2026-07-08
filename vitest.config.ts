// Vitest scoped to the plain-TS layers (EBB protocol/session, plan tape). Deliberately not
// extending vite.config.ts: the app config pulls in the PWA plugin and wasm ?url imports, none of
// which these node-environment tests need.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Same alias as the app's tsconfig/vite config — the live full-chain test loads the real
    // planner wasm (from bytes; no ?url import here).
    alias: { '@wasm': fileURLToPath(new URL('./crate/pkg', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
