import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SideChat from '../src/index.ts'
import {
  captureStableSnapshot,
  DEFAULT_SIDECHAT_PROVIDER,
  renderCurrentTurnObservation,
  renderSnapshotSummary,
  resolveSideChatRoute,
  SideChatTaskService,
  SIDECHAT_OBSERVATION_MAX_CHARS,
  SIDECHAT_TOOL_ALLOWLIST,
  type Config,
  type StableSnapshot,
} from '../src/index.ts'

const disabledObserver: Config = {
  observeEvents: false,
  eventTypes: [],
  subagentProvider: DEFAULT_SIDECHAT_PROVIDER,
  retentionMinutes: 30,
  maxRetainedPerParent: 5,
}
const allCapabilities: SubagentCapabilities = {
  outputSchema: true,
  depthLimit: true,
  toolFilter: true,
  persona: true,
}

interface ControlledRun {
  readonly run: SubagentRun
  readonly result: PromiseWithResolvers<SubagentResult>
  readonly dispose: ReturnType<typeof vi.fn<() => Promise<void>>>
}

class RecordingProvider implements SubagentProvider {
  readonly requests: ResolvedSubagentStartRequest[] = []
  readonly runs: ControlledRun[] = []
  rejectWith: unknown

  constructor(
    readonly name = DEFAULT_SIDECHAT_PROVIDER,
    readonly inheritsParentContext = true,
    readonly capabilities: SubagentCapabilities = allCapabilities,
  ) {}

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.requests.push(request)
    if (this.rejectWith !== undefined) throw this.rejectWith
    const result = Promise.withResolvers<SubagentResult>()
    const dispose = vi.fn(async () => undefined)
    const run: SubagentRun = {
      id: SessionId(`sidechat-child-${String(this.runs.length + 1)}`),
      localAgent: undefined,
      result: result.promise,
      dispose,
    }
    request.signal.addEventListener('abort', () => {
      result.resolve({ output: [], stopReason: 'aborted' })
    }, { once: true })
    this.runs.push({ run, result, dispose })
    return run
  }
}

class GatedProvider extends RecordingProvider {
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()

  override async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.started.resolve()
    await this.release.promise
    return super.start(request)
  }
}

function appendUserMessage(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function closeTurn(session: Session, text = 'closed parent message'): void {
  session.append('turn/start', { turn: 1 })
  appendUserMessage(session, text)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

function agentFor(
  ctx: Context,
  session: Session,
  options: Agent['options'] = { provider: 'mock', model: 'sidechat-model', maxTokens: 321 },
): Agent {
  return { id: session.id, options, session, status: 'idle', ctx } as Agent
}

async function mount(provider = new RecordingProvider()): Promise<{
  ctx: Context
  provider: RecordingProvider
  session: Session
  agent: Agent
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SubagentRuntime)
  vi.spyOn(ctx.subagents, 'listChildren').mockResolvedValue([])
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
    inspect: () => Promise.reject(new Error('unexpected retention inspection')),
  } as never)
  ctx.provide('workspaceRegistry', {
    archivedSessionIds: [],
    archiveSession: () => Promise.resolve(),
  } as never)
  ctx.subagents.registerProvider(provider)
  await ctx.plugin(SideChat, { ...disabledObserver, subagentProvider: provider.name })
  const session = ctx.sessions.create(SessionId('sidechat-command'))
  return { ctx, provider, session, agent: agentFor(ctx, session) }
}

describe('/sidechat native observer subagent', () => {
  it('appears in the catalog and displays stable snapshot metadata without starting a child', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const test = await mount()
    closeTurn(test.session)

    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      name: 'sidechat',
      description: 'inspect the stable snapshot or start one read-only observer subagent',
      input: { hint: '[<question> | cancel [<request-id>]]' },
    })
    const execution = await test.ctx.commands.execute(test.agent, '/sidechat', new AbortController().signal)

    expect(execution?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('SideChat snapshot ready.') })
    expect(execution?.result.text).toContain('Stable turn: 1')
    expect(execution?.result.text).toContain('Boundary seq: 2')
    expect(execution?.result.text).toContain('Current turn: none (idle)')
    expect(execution?.result.text).toContain('Running SideChat agents: 0')
    expect(test.provider.requests).toHaveLength(0)
    await test.ctx.fiber.dispose()
  })

  it('publishes a restricted fork child, releases the command, and keeps the result in the native child lifecycle', async () => {
    const test = await mount()
    closeTurn(test.session, 'closed evidence')
    test.session.append('turn/start', { turn: 2 })
    appendUserMessage(test.session, 'open secret')
    test.ctx.commands.register({
      name: 'ping',
      description: 'concurrency probe',
      handler: () => ({ kind: 'success', text: 'pong' }),
    })

    const execution = await test.ctx.commands.execute(
      test.agent,
      '/sidechat Why did the parent choose that approach?',
      new AbortController().signal,
    )

    expect(execution?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('started as a native child agent'),
    })
    expect(execution?.result.text).toContain('sidechat-child-1')
    expect(test.ctx.sideChatTasks.pendingCount(test.session.id)).toBe(1)
    await expect(test.ctx.commands.execute(test.agent, '/ping', new AbortController().signal))
      .resolves.toMatchObject({ result: { kind: 'success', text: 'pong' } })

    expect(test.provider.requests).toHaveLength(1)
    const request = test.provider.requests[0]!
    expect(request.parent).toBe(test.agent)
    expect(request.label).toMatch(/^SideChat · [\da-f]{8}$/u)
    expect(request.agentOptions).toEqual({ provider: 'mock', model: 'sidechat-model', maxTokens: 321 })
    expect(request.toolFilter).toEqual({ allow: [] })
    expect(request.toolFilter?.allow).toBe(SIDECHAT_TOOL_ALLOWLIST)
    expect(request.persona).toContain('read-only observer')
    expect(request.prompt).toEqual([{
      type: 'text',
      text: expect.stringContaining('Stable inherited boundary: turn 1, boundary seq 2'),
    }])
    expect(JSON.stringify(request.prompt)).toContain('Why did the parent choose that approach?')
    expect(JSON.stringify(request.prompt)).toContain('open secret')
    // The command lifecycle event itself is committed at seq 5 but filtered
    // from the observation payload; the capture boundary still reports it.
    expect(JSON.stringify(request.prompt)).toContain('Observation capture seq: 5')
    expect(JSON.stringify(request.prompt)).toContain('Current turn: 2 (running)')
    const commandRun = test.session.events.find(event =>
      event.type === 'command/run' && event.data.name === 'sidechat')
    expect(commandRun?.data).not.toHaveProperty('args')
    expect(test.session.events.some(event =>
      event.type === 'command/run' && event.data.name === 'sidechat-answer')).toBe(false)

    test.provider.runs[0]!.result.resolve({
      output: [{ type: 'text', text: 'native child answer' }],
      stopReason: 'completed',
    })
    await test.ctx.sideChatTasks.whenIdle()
    expect(test.provider.runs[0]!.dispose).toHaveBeenCalledOnce()
    expect(test.ctx.sideChatTasks.pendingCount(test.session.id)).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('supports a first open turn and rejects empty context, missing routes, invalid providers, and startup failures', async () => {
    const noTurn = await mount()
    noTurn.session.append('turn/start', { turn: 1 })
    appendUserMessage(noTurn.session, 'still open')
    const firstTurn = await noTurn.ctx.commands.execute(
      noTurn.agent,
      '/sidechat What happened?',
      new AbortController().signal,
    )
    expect(firstTurn?.result).toMatchObject({ kind: 'success' })
    expect(JSON.stringify(noTurn.provider.requests[0]?.prompt)).toContain('Stable inherited boundary: none')
    expect(JSON.stringify(noTurn.provider.requests[0]?.prompt)).toContain('still open')
    noTurn.provider.runs[0]!.result.resolve({ output: [], stopReason: 'completed' })
    await noTurn.ctx.sideChatTasks.whenIdle()
    await noTurn.ctx.fiber.dispose()

    const emptyContext = await mount()
    await expect(emptyContext.ctx.commands.execute(
      emptyContext.agent,
      '/sidechat What happened?',
      new AbortController().signal,
    )).resolves.toMatchObject({
      result: { kind: 'error', text: expect.stringContaining('completed parent turn or a currently running turn') },
    })
    await emptyContext.ctx.fiber.dispose()

    const noRoute = await mount()
    closeTurn(noRoute.session)
    const noRouteAgent = agentFor(noRoute.ctx, noRoute.session, {})
    await expect(noRoute.ctx.commands.execute(
      noRouteAgent,
      '/sidechat What happened?',
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('cannot resolve a model') } })
    await noRoute.ctx.fiber.dispose()

    const missing = await mount()
    closeTurn(missing.session)
    const missingService = new SideChatTaskService(missing.ctx, 'missing')
    await expect(missingService.start(missing.agent, captureStableSnapshot(missing.session), 'question'))
      .rejects.toThrow('is not available')
    await missing.ctx.fiber.dispose()

    const fresh = new RecordingProvider('fresh', false)
    const noContext = await mount(fresh)
    closeTurn(noContext.session)
    await expect(noContext.ctx.sideChatTasks.start(noContext.agent, captureStableSnapshot(noContext.session), 'question'))
      .rejects.toThrow('does not inherit parent context')
    await noContext.ctx.fiber.dispose()

    const weak = new RecordingProvider('weak', true, { ...allCapabilities, persona: false })
    const noCapabilities = await mount(weak)
    closeTurn(noCapabilities.session)
    await expect(noCapabilities.ctx.sideChatTasks.start(
      noCapabilities.agent,
      captureStableSnapshot(noCapabilities.session),
      'question',
    )).rejects.toThrow('must support persona and tool filtering')
    await noCapabilities.ctx.fiber.dispose()

    const failedProvider = new RecordingProvider()
    failedProvider.rejectWith = 'provider startup failed'
    const failed = await mount(failedProvider)
    closeTurn(failed.session)
    await expect(failed.ctx.commands.execute(
      failed.agent,
      '/sidechat question',
      new AbortController().signal,
    )).resolves.toEqual(expect.objectContaining({
      result: { kind: 'error', text: 'provider startup failed' },
    }))
    await failed.ctx.fiber.dispose()
  })

  it('cancels the newest child, supports display and child ids, and reports misses', async () => {
    const test = await mount()
    closeTurn(test.session)
    const first = await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'first')
    const second = await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'second')

    expect(test.ctx.sideChatTasks.cancel(SessionId('other'))).toBeUndefined()
    const byChild = test.ctx.sideChatTasks.cancel(test.session.id, String(first.childId))
    expect(byChild).toEqual(first)
    const byCommand = await test.ctx.commands.execute(
      test.agent,
      `/sidechat cancel ${second.displayId}`,
      new AbortController().signal,
    )
    expect(byCommand?.result).toEqual({
      kind: 'success',
      text: `Cancellation requested for SideChat ${second.displayId}.`,
    })
    await test.ctx.sideChatTasks.whenIdle()

    const wrong = await test.ctx.commands.execute(
      test.agent,
      '/sidechat cancel missing',
      new AbortController().signal,
    )
    expect(wrong?.result).toEqual({ kind: 'error', text: 'No running SideChat agent matches "missing".' })
    const none = await test.ctx.commands.execute(
      test.agent,
      '/sidechat cancel',
      new AbortController().signal,
    )
    expect(none?.result).toEqual({ kind: 'error', text: 'No SideChat agent is running in this session.' })
    await test.ctx.fiber.dispose()
  })

  it('handles non-completed results, result failures, disposal failures, and plugin shutdown', async () => {
    const test = await mount()
    closeTurn(test.session)
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => undefined)

    const stopped = await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'stopped')
    test.provider.runs[0]!.result.resolve({ output: [], stopReason: 'max-tokens' })
    await test.ctx.sideChatTasks.whenIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${stopped.displayId} stopped with reason max-tokens`))

    await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'failed')
    test.provider.runs[1]!.result.reject(new Error('run infrastructure failed'))
    await test.ctx.sideChatTasks.whenIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run infrastructure failed'))

    await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'bad dispose')
    test.provider.runs[2]!.dispose.mockRejectedValueOnce('dispose failed')
    test.provider.runs[2]!.result.resolve({ output: [], stopReason: 'completed' })
    await test.ctx.sideChatTasks.whenIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispose failed'))

    const rejectedRetention = { settled: vi.fn(() => Promise.reject('retention failed')) }
    const isolated = new SideChatTaskService(test.ctx, DEFAULT_SIDECHAT_PROVIDER, rejectedRetention)
    await isolated.start(test.agent, captureStableSnapshot(test.session), 'bad retention')
    test.provider.runs[3]!.result.resolve({ output: [], stopReason: 'completed' })
    await isolated.whenIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retention failed'))

    const active = await test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'active')
    await test.ctx.sideChatTasks.dispose()
    expect(test.provider.requests.at(-1)?.signal.reason).toEqual(
      new Error(`SideChat agent ${active.displayId} was cancelled because the plugin stopped.`),
    )
    await expect(test.ctx.sideChatTasks.start(test.agent, captureStableSnapshot(test.session), 'again'))
      .rejects.toThrow('shutting down')
    await test.ctx.fiber.dispose()
  })

  it('disposes a child that publishes concurrently with plugin shutdown', async () => {
    const provider = new GatedProvider()
    const test = await mount(provider)
    closeTurn(test.session)
    const starting = test.ctx.sideChatTasks.start(
      test.agent,
      captureStableSnapshot(test.session),
      'racing startup',
    )
    await provider.started.promise

    await test.ctx.sideChatTasks.dispose()
    provider.release.resolve()

    await expect(starting).rejects.toThrow('stopped while the child agent was starting')
    expect(provider.requests[0]?.signal.aborted).toBe(true)
    expect(provider.runs[0]?.dispose).toHaveBeenCalledOnce()
    expect(test.ctx.sideChatTasks.pendingCount(test.session.id)).toBe(0)
    await test.ctx.fiber.dispose()
  })

  it('renders empty and defensive summaries', () => {
    const empty = captureStableSnapshot(Session.create(SessionId('empty-summary')))
    expect(renderSnapshotSummary(empty, 2)).toContain('Running SideChat agents: 2')
    expect(renderCurrentTurnObservation(empty)).toEqual({
      text: '(no committed model-visible messages)',
      truncated: false,
    })
    const running = Session.create(SessionId('running-summary'))
    running.append('turn/start', { turn: 1 })
    expect(renderSnapshotSummary(captureStableSnapshot(running))).toContain('SideChat snapshot ready.')
    const defensive = { ...empty, boundarySeq: 0, turn: 1 } as StableSnapshot
    expect(renderSnapshotSummary(defensive)).toContain('Turn result: unknown')
  })

  it('bounds a large current-turn observation while preserving its beginning and end', () => {
    const session = Session.create(SessionId('large-observation'))
    session.append('turn/start', { turn: 1 })
    appendUserMessage(session, `BEGIN-${'x'.repeat(30_000)}-END`)

    const rendered = renderCurrentTurnObservation(captureStableSnapshot(session))

    expect(rendered.truncated).toBe(true)
    expect(rendered.text).toHaveLength(SIDECHAT_OBSERVATION_MAX_CHARS)
    expect(rendered.text).toContain('BEGIN-')
    expect(rendered.text).toContain('-END')
    expect(rendered.text).toContain('[current-turn observation truncated in the middle]')
  })

  it('prefers logged routes and validates every missing component', () => {
    const session = Session.create(SessionId('logged-route'))
    session.append('request/header', {
      header: { config: { provider: 'logged-provider', model: 'logged-model', maxTokens: 99 } },
      reason: 'initial',
    })
    expect(resolveSideChatRoute({
      options: { provider: 'fallback-provider', model: 'fallback-model', maxTokens: 321 },
      session,
    } as Agent)).toEqual({ provider: 'logged-provider', model: 'logged-model', maxTokens: 99 })

    const fresh = Session.create(SessionId('route-validation'))
    expect(resolveSideChatRoute({ options: { provider: 'mock', model: 'model' }, session: fresh } as Agent))
      .toEqual({ provider: 'mock', model: 'model' })
    for (const options of [{}, { provider: '', model: 'model' }, { provider: 'mock' }, { provider: 'mock', model: '' }]) {
      expect(() => resolveSideChatRoute({ options, session: fresh } as Agent)).toThrow('cannot resolve a model')
    }
  })

  it('rejects an empty direct service question', async () => {
    const test = await mount()
    closeTurn(test.session)
    await expect(test.ctx.sideChatTasks.start(
      test.agent,
      captureStableSnapshot(test.session),
      '   ',
    )).rejects.toThrow('must not be empty')
    await test.ctx.fiber.dispose()
  })
})
