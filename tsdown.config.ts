import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { cli: 'src/cli/bin.ts' },
  outDir: 'lib',
  format: 'esm',
  fixedExtension: false,
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  outputOptions: { banner: '#!/usr/bin/env node' },
})
