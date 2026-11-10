import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['tests/live/**/*.spec.ts'], testTimeout: 600_000, hookTimeout: 120_000, fileParallelism: false } })
