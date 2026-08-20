import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const harnessRoot = process.env.DSH_HARNESS_ROOT
const configPath = process.argv[2]
if (!harnessRoot || !configPath) {
  throw new Error('loader driver requires DSH_HARNESS_ROOT and a config path')
}

function harnessModule(...segments: string[]): string {
  return pathToFileURL(join(harnessRoot!, ...segments)).href
}

const { boot, resolveConfigPath } = await import(harnessModule(
  'packages', 'boot', 'app-boot', 'src', 'index.ts',
))
const { SessionId } = await import(harnessModule(
  'packages', 'core', 'session', 'src', 'types.ts',
))
const { createUserMessage, LlmAdapter } = await import(harnessModule(
  'packages', 'llm', 'llm', 'src', 'index.ts',
))
const { default: SystemPrompt } = await import(harnessModule(
  'packages', 'core', 'system-prompt', 'src', 'index.ts',
))
const { default: ToolRuntime } = await import(harnessModule(
  'packages', 'core', 'tools', 'src', 'index.ts',
))
const { default: AgentRegistry } = await import(harnessModule(
  'packages', 'core', 'agent', 'src', 'index.ts',
))
const { default: AgentLoop } = await import(harnessModule(
  'packages', 'core', 'agent-loop', 'src', 'index.ts',
))
const ForkProvider = await import(harnessModule(
  'packages', 'subagent', 'subagent-fork-in-process', 'src', 'index.ts',
))

class GatedSideChatAdapter extends LlmAdapter {
  readonly requests: Array<{
    messages?: unknown[]
    system?: string
    tools?: unknown[]
  }> = []
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()

  async * stream(options: {
    messages?: unknown[]
    system?: string
    tools?: unknown[]
    signal?: AbortSignal
  }): AsyncIterable<unknown> {
    this.requests.push(options)
    this.started.resolve()
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => reject(options.signal?.reason ?? new Error('aborted'))
      options.signal?.addEventListener('abort', aborted, { once: true })
      this.release.promise.then(() => {
        options.signal?.removeEventListener('abort', aborted)
        resolve()
      }, reject)
    })
    yield { type: 'text-delta', index: 0, text: 'native fork child answer' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const ctx = await boot(
  'dsh-sidechat-loader-smoke',
  resolveConfigPath(configPath, undefined),
)
const adapter = new GatedSideChatAdapter()
try {
  await ctx.plugin(SystemPrompt, { persona: 'Parent smoke-test persona.' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ForkProvider, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)

  const parent = ctx.agentLoop.create(
    SessionId('sidechat-loader-smoke'),
    { provider: 'mock', model: 'mock' },
  )
  parent.session.append('turn/start', { turn: 1 })
  parent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'closed smoke context' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  parent.session.append('turn/start', { turn: 2 })
  parent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'open smoke secret' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const beforeCapture = parent.session.events.length
  const snapshot = ctx.sideChatSnapshots.capture(parent.id)
  if (parent.session.events.length !== beforeCapture) {
    throw new Error('stable snapshot wrote to its parent session')
  }
  if (snapshot.boundarySeq !== 2 || snapshot.events.length !== 3 || snapshot.messages.length !== 1) {
    throw new Error('stable snapshot did not capture the closed parent turn')
  }
  if (!ctx.commands.list(parent).some((command: { name: string }) => command.name === 'sidechat')) {
    throw new Error('/sidechat is missing from the command catalog')
  }

  const signal = new AbortController().signal
  const summary = await ctx.commands.execute(parent, '/sidechat', signal)
  if (summary?.result.kind !== 'success' || !summary.result.text?.includes('Boundary seq: 2')) {
    throw new Error('/sidechat did not display the stable snapshot')
  }
  console.log('[dsh-smoke] /sidechat snapshot boundary=2 messages=1')

  const answer = await ctx.commands.execute(parent, '/sidechat explain the choice', signal)
  if (answer?.result.kind !== 'success' || !answer.result.text?.includes('started as a native child agent')) {
    throw new Error('/sidechat question did not publish a native child')
  }
  const childId = answer.result.text.match(/Child session: (\S+)/u)?.[1]
  if (childId === undefined) throw new Error('/sidechat receipt omitted the child session id')
  await adapter.started.promise

  const child = ctx.agents.get(SessionId(childId))
  if (child === undefined) throw new Error('published SideChat child is absent from the live Agent registry')
  if (child.session.header.origin !== 'subagent' || child.session.header.parentSession !== parent.id) {
    throw new Error('published SideChat child has incorrect parent lineage')
  }
  if (child.session.header.seedLength !== 3) {
    throw new Error('fork child did not stop its seed at the completed parent turn')
  }
  const childLog = JSON.stringify(child.session.events)
  if (!childLog.includes('closed smoke context') || childLog.includes('open smoke secret')) {
    throw new Error('fork child inherited the wrong parent transcript boundary')
  }

  const request = adapter.requests[0]
  if (request === undefined || !request.system?.includes('read-only observer')) {
    throw new Error('SideChat child did not receive its observer persona')
  }
  if (request.tools !== undefined && request.tools.length !== 0) {
    throw new Error('SideChat child exposed model-facing tools')
  }
  if (!JSON.stringify(request.messages).includes('explain the choice')) {
    throw new Error('SideChat question did not reach the child Agent turn')
  }
  const questionRun = parent.session.events.findLast((event: { type: string; data?: { name?: string } }) =>
    event.type === 'command/run' && event.data?.name === 'sidechat')
  if (questionRun?.data && 'args' in questionRun.data) {
    throw new Error('/sidechat recorded the private question in the parent command lifecycle')
  }
  if (parent.session.events.some((event: { type: string; data?: { name?: string } }) =>
    event.type === 'command/run' && event.data?.name === 'sidechat-answer')) {
    throw new Error('/sidechat still wrote the removed custom command-card lifecycle')
  }

  adapter.release.resolve()
  await ctx.sideChatTasks.whenIdle()
  if (ctx.agents.get(SessionId(childId)) !== undefined) {
    throw new Error('settled one-shot SideChat child was not disposed')
  }
  console.log('[dsh-smoke] real fork child inherited the closed turn, ran tool-free, and settled')

  if (snapshot.boundarySeq !== 2 || snapshot.events.length !== 3) {
    throw new Error('stable snapshot changed after its parent advanced')
  }
} finally {
  adapter.release.resolve()
  await ctx.fiber.dispose()
}
