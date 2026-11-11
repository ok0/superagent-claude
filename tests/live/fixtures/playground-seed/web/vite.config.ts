import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:3000', rewrite: path => path.replace(/^\/api/, '') } } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], setupFiles: ['./src/setup.ts'], restoreMocks: true },
})
