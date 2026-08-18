import type { Context } from '@deepseek-ai/cordis'
import { foldSurface } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One model-visible message projected from a stable session prefix. */
export type SnapshotMessage = NonNullable<ReturnType<Session['deriveEventMessage']>>

/** The immutable, last-closed-turn view used to seed a Side Chat. */
export interface StableSnapshot {
  /** Stable identity for this parent and boundary pair. */
  readonly id: string
  /** Parent DSH session from which the snapshot was captured. */
  readonly sessionId: string
  /** Last source seq that existed when capture began, including an open turn. */
  readonly sourceLastSeq: number | null
  /** Inclusive seq of the last closed turn, or null before the first turn end. */
  readonly boundarySeq: number | null
  /** Number of the closed turn represented by the snapshot. */
  readonly turn: number | null
  /** Why that turn ended; null before the first turn end. */
  readonly turnEndReason: SessionEvent<'turn/end'>['data']['reason'] | null
  /** Detached, frozen array containing the canonical event-log prefix. */
  readonly events: readonly SessionEvent[]
  /** Detached, frozen array containing the exact model-visible surface. */
  readonly messages: readonly SnapshotMessage[]
}

/** Raised when a snapshot is requested for a session that is not live. */
export class StableSnapshotSessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`cannot capture Side Chat snapshot: session "${sessionId}" not found`)
    this.name = 'StableSnapshotSessionNotFoundError'
  }
}

/** Locate the last authoritative closed-turn boundary in an event log. */
export function findStableTurnBoundary(
  events: readonly SessionEvent[],
): SessionEvent<'turn/end'> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end') return event
  }
  return undefined
}

/**
 * Capture an immutable session prefix through the last `turn/end` event.
 *
 * Events committed in a currently open turn are deliberately excluded. The
 * returned arrays are detached from the Session, so future parent activity
 * cannot grow or otherwise change an already captured snapshot.
 */
export function captureStableSnapshot(session: Session): StableSnapshot {
  const sourceEvents = session.events
  const sourceLastSeq = sourceEvents.at(-1)?.seq ?? null
  const boundary = findStableTurnBoundary(sourceEvents)
  const prefix = boundary === undefined
    ? []
    : sourceEvents.slice(0, boundary.seq + 1)
  const messages = foldSurface(prefix).nodes
    .map(seq => session.deriveEventMessage(prefix[seq]!))
    .filter((message): message is SnapshotMessage => message !== null)

  return Object.freeze({
    id: `stable:${String(session.id)}:${boundary?.seq ?? 'empty'}`,
    sessionId: String(session.id),
    sourceLastSeq,
    boundarySeq: boundary?.seq ?? null,
    turn: boundary?.data.turn ?? null,
    turnEndReason: boundary?.data.reason ?? null,
    events: Object.freeze(prefix),
    messages: Object.freeze(messages),
  })
}

/** Read-only access point exposed as `ctx.sideChatSnapshots`. */
export class StableSnapshotService {
  constructor(private readonly ctx: Context) {}

  /** Capture the last stable turn of a live DSH session. */
  capture(sessionId: SessionId | string): StableSnapshot {
    const session = this.ctx.sessions.get(sessionId as SessionId)
    if (session === undefined) {
      throw new StableSnapshotSessionNotFoundError(String(sessionId))
    }
    return captureStableSnapshot(session)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stable parent-session snapshot provider installed by dsh-sidechat. */
    sideChatSnapshots: StableSnapshotService
  }
}

/** Install the scoped Side Chat snapshot service into a Cordis context. */
export function installStableSnapshotService(ctx: Context): StableSnapshotService {
  const service = new StableSnapshotService(ctx)
  ctx.provide('sideChatSnapshots', service)
  return service
}
