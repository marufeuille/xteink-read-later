import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['simulator/run.test.ts'],
    testTimeout: 600_000,
    fileParallelism: false,
  },
})
