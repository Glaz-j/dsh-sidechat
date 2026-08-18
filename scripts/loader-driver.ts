import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const configPath = process.argv[2]
if (!harnessRoot || !configPath) {
  throw new Error('loader driver requires DSH_HARNESS_ROOT and a config path')
}

const appBootUrl = pathToFileURL(
  join(harnessRoot, 'packages', 'boot', 'app-boot', 'src', 'index.ts'),
).href
const sessionUrl = pathToFileURL(
  join(harnessRoot, 'packages', 'core', 'session', 'src', 'types.ts'),
).href
const { boot, resolveConfigPath } = await import(appBootUrl)
const { SessionId } = await import(sessionUrl)

const ctx = await boot(
  'dsh-sidechat-loader-smoke',
  resolveConfigPath(configPath, undefined),
)
try {
  const session = ctx.sessions.create(SessionId('sidechat-loader-smoke'))
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
} finally {
  await ctx.fiber.dispose()
}
