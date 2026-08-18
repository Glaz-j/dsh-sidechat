import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  dts: true,
  clean: true,
  hash: false,
  fixedExtension: false,
  sourcemap: true,
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
  },
})
