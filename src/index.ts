/**
 * Read-only DeepSeek Harness session observer and stable-snapshot provider.
 * It exposes a closed-turn context boundary without changing an Agent or its
 * durable history.
 *
 * @module dsh-sidechat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import Schema from '@deepseek-ai/schemastery'
import { installSideChatTaskService, registerSideChatCommand } from './command.ts'
import { installStableSnapshotService } from './stable-snapshot.ts'
import {
  DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT,
  DEFAULT_SIDECHAT_RETENTION_MINUTES,
  installSideChatRetentionService,
} from './retention.ts'

export {
  DEFAULT_SIDECHAT_PROVIDER,
  executeSideChatCommand,
  installSideChatTaskService,
  registerSideChatCommand,
  renderCurrentTurnObservation,
  renderSnapshotSummary,
  resolveSideChatRoute,
  SIDECHAT_OBSERVATION_MAX_CHARS,
  SIDECHAT_TOOL_ALLOWLIST,
  SideChatTaskService,
} from './command.ts'
export type { SideChatRoute, SideChatTaskReceipt } from './command.ts'
export {
  captureStableSnapshot,
  findStableTurnBoundary,
  installStableSnapshotService,
  StableSnapshotService,
  StableSnapshotSessionNotFoundError,
} from './stable-snapshot.ts'
export type {
  CurrentTurnMessage,
  CurrentTurnSnapshot,
  SnapshotMessage,
  StableSnapshot,
} from './stable-snapshot.ts'
export {
  DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT,
  DEFAULT_SIDECHAT_RETENTION_MINUTES,
  installSideChatRetentionService,
  SIDECHAT_LABEL_PREFIX,
  SideChatRetentionService,
} from './retention.ts'
export type { SideChatRetentionHost } from './retention.ts'

/** Deployment configuration for optional metadata-only event observation. */
export interface Config {
  /** Whether committed session events are written to the host log. */
  observeEvents: boolean
  /** Event types to include; an empty list includes every event type. */
  eventTypes: string[]
  /** DSH provider used to create observable parent-history fork children. */
  subagentProvider: string
  /** Minutes a completed SideChat remains visible before durable archiving. */
  retentionMinutes: number
  /** Maximum completed SideChats visible under one direct parent. */
  maxRetainedPerParent: number
}
/** Runtime validation and defaults for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  observeEvents: Schema.boolean().default(true),
  eventTypes: Schema.array(Schema.string()).default([]),
  subagentProvider: Schema.string().default('fork'),
  retentionMinutes: Schema.number().default(DEFAULT_SIDECHAT_RETENTION_MINUTES),
  maxRetainedPerParent: Schema.number().default(DEFAULT_SIDECHAT_MAX_RETAINED_PER_PARENT),
})

/** A privacy-preserving summary of one committed session event. */
export interface ObservedSessionEvent {
  /** Owning DSH session id. */
  sessionId: string
  /** Monotonic event sequence number. */
  seq: number
  /** Durable event discriminant. */
  type: string
}

/** Plugin name displayed by Cordis and in lifecycle messages. */
export const name = 'dsh-sidechat'

/** DSH services that must exist before the command and observer are mounted. */
export const inject = ['sessions', 'commands', 'subagents', 'sessionPersistence', 'workspaceRegistry']

/**
 * Reduce a DSH event to fields safe for the observer milestone.
 *
 * @param session - Session that owns the committed event.
 * @param event - Exact event appended to the durable log.
 * @returns A summary that excludes message text, tool arguments, and results.
 */
export function summarizeSessionEvent(
  session: Pick<Session, 'id'>,
  event: Pick<SessionEvent, 'seq' | 'type'>,
): ObservedSessionEvent {
  return {
    sessionId: String(session.id),
    seq: event.seq,
    type: event.type,
  }
}

/**
 * Format one observer summary for the host log.
 *
 * @param event - Privacy-preserving session event summary.
 * @returns One stable, grep-friendly log line.
 */
export function formatObservedEvent(event: ObservedSessionEvent): string {
  return `[dsh-sidechat] session=${event.sessionId} seq=${event.seq} event=${event.type}`
}

/**
 * Decide whether an event is included by the configured allowlist.
 *
 * @param eventType - Durable event discriminant.
 * @param configuredTypes - Empty for all events, otherwise an exact allowlist.
 * @returns Whether the observer should write this event summary.
 */
export function shouldObserveEvent(
  eventType: string,
  configuredTypes: readonly string[],
): boolean {
  return configuredTypes.length === 0 || configuredTypes.includes(eventType)
}

/**
 * Mount the Side Chat snapshot service and optional observer.
 *
 * @param ctx - Settled Harness context containing the session service.
 * @param config - Validated observer configuration.
 */
export function apply(ctx: Context, config: Config): void {
  installStableSnapshotService(ctx)
  installSideChatRetentionService(ctx, config.retentionMinutes, config.maxRetainedPerParent)
  installSideChatTaskService(ctx, config.subagentProvider)
  registerSideChatCommand(ctx)

  ctx.effect(() => {
    console.log('[dsh-sidechat] plugin loaded (native observer subagent)')
    return () => console.log('[dsh-sidechat] plugin unloaded')
  }, 'dsh-sidechat.lifecycle')

  if (!config.observeEvents) return

  ctx.on('session/event', (session, event) => {
    if (!shouldObserveEvent(event.type, config.eventTypes)) return
    console.log(formatObservedEvent(summarizeSessionEvent(session, event)))
  })
}
