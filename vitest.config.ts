import { configDefaults, defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, 'tests/live/**'],
    setupFiles: ['tests/fixtures/network-guard.ts'],
  },
})
