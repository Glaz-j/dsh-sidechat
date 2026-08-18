import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SideChat from '../src/index.ts'
import {
  apply,
  formatObservedEvent,
  shouldObserveEvent,
  summarizeSessionEvent,
  type Config,
} from '../src/index.ts'

const enabled: Config = { observeEvents: true, eventTypes: [] }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('observer summary', () => {
  it('keeps identity and ordering fields while excluding event payloads', () => {
    const summary = summarizeSessionEvent(
      { id: SessionId('parent-session') },
      { seq: 7, type: 'tool/result' },
    )

    expect(summary).toEqual({
      sessionId: 'parent-session',
      seq: 7,
      type: 'tool/result',
    })
    expect(formatObservedEvent(summary)).toBe(
      '[dsh-sidechat] session=parent-session seq=7 event=tool/result',
    )
  })

  it('supports all events or an exact event-type allowlist', () => {
    expect(shouldObserveEvent('turn/start', [])).toBe(true)
    expect(shouldObserveEvent('turn/start', ['turn/start'])).toBe(true)
    expect(shouldObserveEvent('step/start', ['turn/start'])).toBe(false)
  })
})

describe('Cordis plugin', () => {
  it('observes committed DSH session events without appending its own events', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SideChat, enabled)
    const session = ctx.sessions.create(SessionId('isolation-probe'))
    const before = session.events.length

    session.append('turn/start', { turn: 1 })

    expect(session.events).toHaveLength(before + 1)
    expect(log).toHaveBeenCalledWith(
      '[dsh-sidechat] session=isolation-probe seq=0 event=turn/start',
    )
    await ctx.fiber.dispose()
  })

  it('can load with event observation disabled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin({ name: 'sidechat-disabled', apply }, {
      observeEvents: false,
      eventTypes: [],
    })
    const session = ctx.sessions.create(SessionId('disabled-probe'))

    session.append('turn/start', { turn: 1 })

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('session=disabled-probe'))
    await ctx.fiber.dispose()
  })

  it('applies the configured event-type allowlist to the live feed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SideChat, {
      observeEvents: true,
      eventTypes: ['turn/end'],
    })
    const session = ctx.sessions.create(SessionId('filtered-probe'))

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('event=turn/start'))
    expect(log).toHaveBeenCalledWith(
      '[dsh-sidechat] session=filtered-probe seq=1 event=turn/end',
    )
    await ctx.fiber.dispose()
  })
})
