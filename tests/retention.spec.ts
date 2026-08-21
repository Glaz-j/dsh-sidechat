import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import {
  SIDECHAT_LABEL_PREFIX,
  SideChatRetentionService,
  installSideChatRetentionService,
  type SideChatRetentionHost,
} from '../src/index.ts'

const sid = (value: string): SessionId => value as SessionId
const parent = sid('parent')

function header(id: string, createdAt: number, parentSession: SessionId = parent): SessionHeader {
  return { version: 0, id: sid(id), createdAt, parentSession, origin: 'subagent' }
}

function child(
  id: string,
  activity: 'running' | 'inactive' = 'inactive',
  label = `${SIDECHAT_LABEL_PREFIX}${id}`,
): SubagentListEntry {
  return { kind: 'child', id: sid(id), mode: 'one-shot', label, activity, hasChildren: false }
}

function event(type: 'turn/start' | 'turn/end', time: number): SessionEvent {
  return (type === 'turn/end'
    ? { type, seq: 1, time, data: { turn: 1, reason: { kind: 'completed' } } }
    : { type, seq: 0, time, data: { turn: 1 } }) as SessionEvent
}

class Host implements SideChatRetentionHost {
  archivedSessionIds: SessionId[] = []
  headers: SessionHeader[] = []
  entries = new Map<SessionId, SubagentListEntry[]>()
  events = new Map<SessionId, SessionEvent[]>()
  archives: SessionId[] = []

  listHeaders = vi.fn(async () => this.headers)
  listChildren = vi.fn(async (parentId: SessionId) => this.entries.get(parentId) ?? [])
  inspectEvents = vi.fn(async (id: SessionId) => this.events.get(id) ?? [])
  archive = vi.fn(async (id: SessionId) => {
    this.archives.push(id)
    this.archivedSessionIds.push(id)
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SideChat retention', () => {
  it('reconciles children created before the Parallel Chat rename', async () => {
    const host = new Host()
    host.headers = [header('legacy', 1)]
    host.entries.set(parent, [child('legacy', 'inactive', 'SideChat · legacy')])
    host.events.set(sid('legacy'), [event('turn/end', 1)])
    const service = new SideChatRetentionService(host, 1, 5, () => 2)

    await service.reconcile()

    expect(host.archives).toEqual([sid('legacy')])
    await service.dispose()
  })

  it('archives a completed child when its visibility window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const host = new Host()
    host.headers = []
    host.entries.set(parent, [child('child')])
    const service = new SideChatRetentionService(host, 1_000, 5)

    await service.settled(parent, sid('child'))
    await service.settled(parent, sid('child'))
    expect(host.archives).toEqual([])
    vi.setSystemTime(11_000)
    await vi.runOnlyPendingTimersAsync()
    await service.whenIdle()

    expect(host.archives).toEqual([sid('child')])
    await service.dispose()
  })

  it('keeps only the newest completed children while ignoring running, foreign, and archived rows', async () => {
    const host = new Host()
    host.archivedSessionIds.push(sid('already'))
    host.headers = [
      header('old', 1), header('new', 2), header('running', 3), header('foreign', 4), header('already', 5),
    ]
    host.entries.set(parent, [
      child('old'), child('new'), child('running', 'running'), child('foreign', 'inactive', 'Other agent'),
      child('already'), { kind: 'diagnostic', id: sid('bad'), reason: 'corrupt' },
    ])
    host.events.set(sid('old'), [event('turn/end', 100)])
    host.events.set(sid('new'), [event('turn/end', 200)])
    const service = new SideChatRetentionService(host, 10_000, 1, () => 500)

    await service.reconcile()

    expect(host.archives).toEqual([sid('old')])
    expect(host.inspectEvents).toHaveBeenCalledTimes(2)
    await service.dispose()
  })

  it('reconstructs restart deadlines from final-event and header fallbacks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const otherParent = sid('other-parent')
    const host = new Host()
    host.headers = [
      header('last-event', 100), header('header-only', 200),
      { version: 0, id: sid('ordinary'), createdAt: 1 },
      header('other', 300, otherParent),
    ]
    host.entries.set(parent, [child('last-event'), child('header-only'), child('missing-header')])
    host.entries.set(otherParent, [])
    host.events.set(sid('last-event'), [event('turn/start', 400)])
    host.events.set(sid('header-only'), [])
    const service = new SideChatRetentionService(host, 1_000, 5)

    await service.reconcile()
    vi.setSystemTime(1_200)
    await vi.runOnlyPendingTimersAsync()
    await service.whenIdle()

    expect(host.archives).toEqual([sid('header-only'), sid('last-event'), sid('missing-header')])
    expect(host.listChildren).toHaveBeenCalledWith(otherParent)
    await service.dispose()
  })

  it('validates limits, serializes after an earlier failure, and makes disposal quiescent', async () => {
    const host = new Host()
    expect(() => new SideChatRetentionService(host, 0, 1)).toThrow('duration')
    expect(() => new SideChatRetentionService(host, 1, 0)).toThrow('retained-count')
    expect(() => new SideChatRetentionService(host, 1.5, 1)).toThrow('duration')
    expect(() => new SideChatRetentionService(host, 1, 1.5)).toThrow('retained-count')

    host.headers = [header('child', 1)]
    host.entries.set(parent, [child('child')])
    host.listChildren.mockRejectedValueOnce(new Error('temporary read failure'))
    const service = new SideChatRetentionService(host, 10_000, 5)
    await expect(service.settled(parent, sid('child'), 2)).rejects.toThrow('temporary read failure')
    await expect(service.settled(parent, sid('child'), 3)).resolves.toBeUndefined()
    await service.dispose()
    await expect(service.settled(parent, sid('later'))).resolves.toBeUndefined()
    await expect(service.reconcile()).resolves.toBeUndefined()
  })

  it('does not archive an id that another writer archived before its timer', async () => {
    vi.useFakeTimers()
    const host = new Host()
    host.headers = [header('child', 1)]
    host.entries.set(parent, [child('child')])
    const service = new SideChatRetentionService(host, 1, 5, () => 0)
    await service.settled(parent, sid('child'), 0)
    host.archivedSessionIds.push(sid('child'))
    await vi.runOnlyPendingTimersAsync()
    await service.whenIdle()
    expect(host.archive).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('uses deterministic tie breakers and clears a previously scheduled timer on capacity archival', async () => {
    vi.useFakeTimers()
    const host = new Host()
    host.headers = [header('a', 1), header('b', 1), header('c', 2)]
    host.entries.set(parent, [child('a')])
    const service = new SideChatRetentionService(host, 10_000, 1, () => 100)
    await service.settled(parent, sid('a'), 50)
    host.entries.set(parent, [child('a'), child('b'), child('c')])
    host.events.set(sid('b'), [event('turn/end', 50)])
    host.events.set(sid('c'), [event('turn/end', 50)])

    await service.reconcile()

    expect(host.archives).toEqual([sid('b'), sid('a')])
    await service.dispose()
  })

  it('lets a queued enforcement observe shutdown before it reads children', async () => {
    const host = new Host()
    const gate = Promise.withResolvers<SessionHeader[]>()
    host.listHeaders.mockImplementationOnce(() => gate.promise)
    const service = new SideChatRetentionService(host, 1_000, 5)
    const settling = service.settled(parent, sid('child'))
    await Promise.resolve()
    const disposing = service.dispose()
    gate.resolve([])

    await settling
    await disposing
    expect(host.listChildren).not.toHaveBeenCalled()
  })

  it('binds persistence and workspace adapters and reports startup reconciliation failures', async () => {
    const archived: SessionId[] = []
    const ctx = new Context()
    expect(() => installSideChatRetentionService(ctx, 0.5, 5)).toThrow('retentionMinutes')
    ctx.provide('sessionPersistence', {
      list: () => Promise.resolve([header('adapter', 1)]),
      inspect: () => Promise.resolve({ meta: header('adapter', 1), events: [event('turn/end', 2)] }),
    } as never)
    ctx.provide('subagents', { listChildren: () => Promise.resolve([child('adapter')]) } as never)
    ctx.provide('workspaceRegistry', {
      archivedSessionIds: archived,
      archiveSession: async (id: SessionId) => { archived.push(id) },
    } as never)
    const service = installSideChatRetentionService(ctx, 1, 5)
    await service.reconcile()
    expect(archived).toEqual([sid('adapter')])
    await ctx.fiber.dispose()

    for (const failure of [new Error('startup failed'), 'string failure']) {
      const failed = new Context()
      const warn = vi.spyOn(failed.logger, 'warn').mockImplementation(() => undefined)
      failed.provide('sessionPersistence', { list: () => Promise.reject(failure) } as never)
      failed.provide('subagents', {} as never)
      failed.provide('workspaceRegistry', { archivedSessionIds: [] } as never)
      installSideChatRetentionService(failed)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(
        failure instanceof Error ? failure.message : failure,
      ))
      await failed.fiber.dispose()
    }
  })
})
