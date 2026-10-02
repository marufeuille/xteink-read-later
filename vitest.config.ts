import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:sockets': fileURLToPath(new URL('./test/cloudflare-sockets-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**'],
  },
})
