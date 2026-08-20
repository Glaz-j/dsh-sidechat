import { defineConfig, type UserConfig } from 'tsdown'

const host: UserConfig = {
  name: 'dsh-sidechat',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  dts: true,
  clean: true,
  hash: false,
  fixedExtension: false,
  sourcemap: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-subagent',
    ],
  },
}

export default defineConfig(host)
