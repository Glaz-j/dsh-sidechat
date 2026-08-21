import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SubagentListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-workspace'

/** Durable label prefix used to distinguish SideChat children from other subagents. */
export const SIDECHAT_LABEL_PREFIX = 'SideChat · '

/** Default time that a completed SideChat remains visible. */
export const DEFAULT_SIDECHAT_RETENTION_MINUTES = 30

/** Default number of completed SideChats retained per direct parent. */
export const DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT = 5

interface SettledSideChat {
  readonly id: SessionId
  readonly parentId: SessionId
  readonly settledAt: number
  readonly createdAt: number
}

/** Minimal host surface used by the retention policy and deterministic tests. */
export interface SideChatRetentionHost {
  readonly archivedSessionIds: readonly SessionId[]
  listHeaders(): Promise<readonly SessionHeader[]>
  listChildren(parentId: SessionId): Promise<readonly SubagentListEntry[]>
  inspectEvents(id: SessionId): Promise<readonly SessionEvent[]>
  archive(id: SessionId): Promise<void>
}

function lastSettlementTime(events: readonly SessionEvent[], fallback: number): number {
  return events.findLast(event => event.type === 'turn/end')?.time
    ?? events.at(-1)?.time
    ?? fallback
}

function isSideChat(entry: SubagentListEntry): entry is Extract<SubagentListEntry, { kind: 'child' }> {
  return entry.kind === 'child'
    && entry.mode === 'one-shot'
    && entry.label?.startsWith(SIDECHAT_LABEL_PREFIX) === true
}

function compareNewestFirst(left: SettledSideChat, right: SettledSideChat): number {
  return right.settledAt - left.settledAt
    || right.createdAt - left.createdAt
    || String(right.id).localeCompare(String(left.id))
}

/** Archives completed SideChats by age and per-parent capacity. */
export class SideChatRetentionService {
  private readonly records = new Map<SessionId, SettledSideChat>()
  private readonly timers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  private readonly operations = new Map<SessionId, Promise<void>>()
  private disposed = false

  constructor(
    private readonly host: SideChatRetentionHost,
    private readonly retentionMs = DEFAULT_SIDECHAT_RETENTION_MINUTES * 60_000,
    private readonly maxRetainedPerParent = DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
      throw new Error('SideChat retention duration must be a positive integer number of milliseconds.')
    }
    if (!Number.isSafeInteger(maxRetainedPerParent) || maxRetainedPerParent < 1) {
      throw new Error('SideChat retained-count limit must be a positive integer.')
    }
  }

  /** Rebuild timers and enforce capacity from durable child history after startup. */
  async reconcile(): Promise<void> {
    if (this.disposed) return
    const headers = await this.host.listHeaders()
    const parentIds = new Set(headers.flatMap(header =>
      header.origin === 'subagent' && header.parentSession !== undefined ? [header.parentSession] : []))
    await Promise.all([...parentIds].map(parentId => this.enqueue(parentId, () => this.enforce(parentId, headers))))
  }

  /** Record a newly completed child after its native run releases runtime resources. */
  settled(parentId: SessionId, id: SessionId, settledAt = this.now()): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.records.set(id, { id, parentId, settledAt, createdAt: settledAt })
    return this.enqueue(parentId, async () => {
      await this.enforce(parentId, await this.host.listHeaders())
    })
  }

  /** Await all policy operations currently accepted; intended for tests and shutdown. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.operations.values()])
  }

  /** Cancel future archival work and await in-flight durable writes. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await this.whenIdle()
  }

  private enqueue(parentId: SessionId, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(parentId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.operations.set(parentId, current)
    const release = (): void => {
      if (this.operations.get(parentId) === current) this.operations.delete(parentId)
    }
    void current.then(release, release)
    return current
  }

  private async enforce(parentId: SessionId, headers: readonly SessionHeader[]): Promise<void> {
    if (this.disposed) return
    const archived = new Set(this.host.archivedSessionIds)
    const headersById = new Map(headers.map(header => [header.id, header]))
    const entries = await this.host.listChildren(parentId)
    const candidates: SettledSideChat[] = []

    for (const entry of entries) {
      if (!isSideChat(entry) || entry.activity === 'running' || archived.has(entry.id)) continue
      const header = headersById.get(entry.id)
      const remembered = this.records.get(entry.id)
      const settledAt = remembered?.settledAt
        ?? lastSettlementTime(await this.host.inspectEvents(entry.id), header?.createdAt ?? this.now())
      const record = {
        id: entry.id,
        parentId,
        settledAt,
        createdAt: header?.createdAt ?? remembered?.createdAt ?? settledAt,
      }
      this.records.set(entry.id, record)
      candidates.push(record)
    }

    candidates.sort(compareNewestFirst)
    const expiredAt = this.now() - this.retentionMs
    for (const [index, candidate] of candidates.entries()) {
      if (index >= this.maxRetainedPerParent || candidate.settledAt <= expiredAt) await this.archive(candidate)
      else this.schedule(candidate)
    }
  }

  private schedule(record: SettledSideChat): void {
    const existing = this.timers.get(record.id)
    if (existing !== undefined) clearTimeout(existing)
    const delay = Math.max(0, record.settledAt + this.retentionMs - this.now())
    const timer = setTimeout(() => {
      this.timers.delete(record.id)
      void this.enqueue(record.parentId, () => this.archive(record))
    }, delay)
    this.timers.set(record.id, timer)
  }

  private async archive(record: SettledSideChat): Promise<void> {
    if (this.disposed || this.host.archivedSessionIds.includes(record.id)) return
    const timer = this.timers.get(record.id)
    if (timer !== undefined) clearTimeout(timer)
    this.timers.delete(record.id)
    await this.host.archive(record.id)
    this.records.delete(record.id)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Completed-child retention policy installed by dsh-sidechat. */
    sideChatRetention: SideChatRetentionService
  }
}

/** Bind the retention policy to DSH persistence and workspace archiving. */
export function installSideChatRetentionService(
  ctx: Context,
  retentionMinutes = DEFAULT_SIDECHAT_RETENTION_MINUTES,
  maxRetainedPerParent = DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT,
): SideChatRetentionService {
  if (!Number.isSafeInteger(retentionMinutes) || retentionMinutes < 1) {
    throw new Error('SideChat retentionMinutes must be a positive integer.')
  }
  const service = new SideChatRetentionService({
    get archivedSessionIds() { return ctx.workspaceRegistry.archivedSessionIds },
    listHeaders: () => ctx.sessionPersistence.list(),
    listChildren: parentId => ctx.subagents.listChildren(parentId),
    inspectEvents: async id => (await ctx.sessionPersistence.inspect(id)).events,
    archive: id => ctx.workspaceRegistry.archiveSession(id),
  }, retentionMinutes * 60_000, maxRetainedPerParent)
  ctx.provide('sideChatRetention', service)
  ctx.effect(() => {
    void service.reconcile().catch((error: unknown) => {
      ctx.logger.warn(`SideChat retention reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return async () => { await service.dispose() }
  }, 'dsh-sidechat.retention')
  return service
}
