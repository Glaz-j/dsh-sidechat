import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SideChat from '../src/index.ts'
import {
  captureStableSnapshot,
  findStableTurnBoundary,
  StableSnapshotSessionNotFoundError,
  type Config,
} from '../src/index.ts'

const disabledObserver: Config = {
  observeEvents: false,
  eventTypes: [],
  subagentProvider: 'fork',
  retentionMinutes: 30,
  maxRetainedPerParent: 5,
}

async function mountRequiredServices(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SubagentRuntime)
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([]),
    inspect: () => Promise.reject(new Error('unexpected retention inspection')),
  } as never)
  ctx.provide('workspaceRegistry', {
    archivedSessionIds: [],
    archiveSession: () => Promise.resolve(),
  } as never)
}

function appendUserMessage(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('stable boundary selection', () => {
  it('returns no boundary before a turn closes', () => {
    const session = Session.create(SessionId('open-only'))
    expect(captureStableSnapshot(session).sourceLastSeq).toBeNull()
    session.append('turn/start', { turn: 1 })

    expect(findStableTurnBoundary(session.events)).toBeUndefined()
    expect(captureStableSnapshot(session)).toMatchObject({
      id: 'sidechat:open-only:stable-empty:capture-0',
      sessionId: 'open-only',
      sourceLastSeq: 0,
      boundarySeq: null,
      turn: null,
      turnEndReason: null,
      events: [],
      messages: [],
      currentTurn: {
        status: 'running',
        turn: 1,
        startSeq: 0,
        captureSeq: 0,
        eventCount: 1,
        messages: [],
      },
    })
  })

  it('returns the latest turn/end regardless of its closing reason', () => {
    const session = Session.create(SessionId('two-closed-turns'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', {
      turn: 2,
      reason: { kind: 'aborted', reason: { kind: 'user' } },
    })

    expect(findStableTurnBoundary(session.events)).toBe(session.events[3])
  })
})

describe('stable snapshot capture', () => {
  it('excludes an open turn and reconstructs the exact model-visible prefix', () => {
    const session = Session.create(SessionId('stable-prefix'))
    session.append('turn/start', { turn: 1 })
    appendUserMessage(session, 'closed question')
    appendUserMessage(session, 'closed detail')
    const originalNodes = session.surface.nodes
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted closed context' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: {
        op: 'replace',
        start: originalNodes[0]!,
        end: originalNodes[1]!,
      },
      sourceEventSeqs: [originalNodes[0]!, originalNodes[1]!],
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: { provider: 'test', model: 'empty' },
      }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    appendUserMessage(session, 'still running')

    const beforeCapture = session.events.length
    const snapshot = captureStableSnapshot(session)

    expect(session.events).toHaveLength(beforeCapture)
    expect(snapshot).toMatchObject({
      id: 'sidechat:stable-prefix:stable-5:capture-7',
      sessionId: 'stable-prefix',
      sourceLastSeq: 7,
      boundarySeq: 5,
      turn: 1,
      turnEndReason: { kind: 'completed' },
    })
    expect(snapshot.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.messages[0]?.content).toEqual([
      { type: 'text', text: 'compacted closed context' },
    ])
    expect(snapshot.currentTurn).toMatchObject({
      status: 'running',
      turn: 2,
      startSeq: 6,
      captureSeq: 7,
      eventCount: 2,
    })
    expect(snapshot.currentTurn.messages).toEqual([{
      seq: 7,
      message: expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'still running' }],
      }),
    }])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.events)).toBe(true)
    expect(Object.isFrozen(snapshot.messages)).toBe(true)
    expect(Object.isFrozen(snapshot.currentTurn)).toBe(true)
    expect(Object.isFrozen(snapshot.currentTurn.messages)).toBe(true)
    expect(Object.isFrozen(snapshot.currentTurn.messages[0])).toBe(true)
  })

  it('keeps current-turn model messages while filtering internal and replacement events', () => {
    const session = Session.create(SessionId('filtered-current'))
    session.append('turn/start', { turn: 1 })
    appendUserMessage(session, 'visible current request')
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'private partial chunk' },
    })
    session.append('todo/write', { todos: [] })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [],
        source: { provider: 'test', model: 'empty-current' },
      }),
    }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement-only context' }],
      source: { kind: 'plugin', plugin: 'test-compaction' },
    }), {
      surfaceOp: { op: 'replace', start: 1, end: 1 },
      sourceEventSeqs: [1],
    })

    const snapshot = captureStableSnapshot(session)

    expect(snapshot.currentTurn.eventCount).toBe(6)
    expect(snapshot.currentTurn.messages.map(entry => entry.seq)).toEqual([1])
    const serialized = JSON.stringify(snapshot.currentTurn.messages)
    expect(serialized).toContain('visible current request')
    expect(serialized).not.toContain('private partial chunk')
    expect(serialized).not.toContain('replacement-only context')
  })

  it('does not change after the parent session advances', () => {
    const session = Session.create(SessionId('immutable-prefix'))
    session.append('turn/start', { turn: 1 })
    appendUserMessage(session, 'first')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const snapshot = captureStableSnapshot(session)

    session.append('turn/start', { turn: 2 })
    appendUserMessage(session, 'second')
    const openSnapshot = captureStableSnapshot(session)
    appendUserMessage(session, 'late second detail')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    expect(snapshot.boundarySeq).toBe(2)
    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.messages).toHaveLength(1)
    expect(snapshot.currentTurn).toMatchObject({ status: 'idle', eventCount: 0, messages: [] })
    expect(openSnapshot.currentTurn.messages).toHaveLength(1)
    expect(JSON.stringify(openSnapshot.currentTurn.messages)).not.toContain('late second detail')
    expect(captureStableSnapshot(session).boundarySeq).toBe(6)
  })
})

describe('snapshot service', () => {
  it('captures a live session by id without writing to it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ctx = new Context()
    await mountRequiredServices(ctx)
    await ctx.plugin(SideChat, disabledObserver)
    const session = ctx.sessions.create(SessionId('service-parent'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const before = session.events.length

    const snapshot = ctx.sideChatSnapshots.capture('service-parent')

    expect(snapshot.boundarySeq).toBe(1)
    expect(session.events).toHaveLength(before)
    await ctx.fiber.dispose()
  })

  it('reports an unknown live session with a typed error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ctx = new Context()
    await mountRequiredServices(ctx)
    await ctx.plugin(SideChat, disabledObserver)

    expect(() => ctx.sideChatSnapshots.capture('missing')).toThrow(
      new StableSnapshotSessionNotFoundError('missing'),
    )
    await ctx.fiber.dispose()
  })
})
