import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['simulator/run.test.ts'],
    testTimeout: 1_800_000,
    fileParallelism: false,
  },
})
