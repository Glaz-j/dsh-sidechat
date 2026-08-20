import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const harnessRoot = process.env.DSH_HARNESS_ROOT
if (!harnessRoot) throw new Error('DSH_HARNESS_ROOT is required')

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = join(projectRoot, '.smoke-logs')
const configPath = join(scratch, 'cordis.yml')
const driverPath = join(projectRoot, 'scripts', 'loader-driver.ts')

const sessionPlugin = pathToFileURL(
  join(resolve(harnessRoot), 'packages', 'core', 'session', 'src', 'index.ts'),
).href
const llmPlugin = pathToFileURL(
  join(resolve(harnessRoot), 'packages', 'llm', 'llm', 'src', 'index.ts'),
).href
const commandsPlugin = pathToFileURL(
  join(resolve(harnessRoot), 'packages', 'interaction', 'commands', 'src', 'index.ts'),
).href
const subagentPlugin = pathToFileURL(
  join(resolve(harnessRoot), 'packages', 'subagent', 'subagent', 'src', 'index.ts'),
).href
const sideChatPlugin = pathToFileURL(join(projectRoot, 'lib', 'index.js')).href

await mkdir(scratch, { recursive: true })
await writeFile(configPath, [
  '- id: sessions',
  `  name: '${sessionPlugin}'`,
  '- id: llm',
  `  name: '${llmPlugin}'`,
  '- id: commands',
  `  name: '${commandsPlugin}'`,
  '- id: subagents',
  `  name: '${subagentPlugin}'`,
  '- id: sidechat-observer',
  `  name: '${sideChatPlugin}'`,
  '  config:',
  '    observeEvents: true',
  '    eventTypes: []',
  '    subagentProvider: fork',
  '',
].join('\n'))

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', driverPath, configPath],
  {
    cwd: resolve(harnessRoot),
    env: {
      ...process.env,
      DSH_HARNESS_ROOT: resolve(harnessRoot),
      TSX_TSCONFIG_PATH: join(resolve(harnessRoot), 'tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })

const result = await new Promise((resolveResult, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error('DSH Loader smoke timed out after 30 seconds'))
  }, 30_000)
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    resolveResult({ code, signal })
  })
})

try {
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  if (result.code !== 0) {
    throw new Error(`DSH Loader smoke exited ${String(result.code)} (${String(result.signal)})`)
  }
  const expected = [
    '[dsh-sidechat] plugin loaded (native observer subagent)',
    '[dsh-sidechat] session=sidechat-loader-smoke seq=0 event=turn/start',
    '[dsh-sidechat] session=sidechat-loader-smoke seq=2 event=turn/end',
    '[dsh-smoke] /sidechat snapshot boundary=2 messages=1',
    '[dsh-smoke] real fork child inherited the closed turn, ran tool-free, and settled',
    '[dsh-sidechat] plugin unloaded',
  ]
  for (const line of expected) {
    if (!stdout.includes(line)) throw new Error(`missing loader proof: ${line}`)
  }
  console.log('[dsh-smoke] bundle loaded and delegated /sidechat to the native subagent seam')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
