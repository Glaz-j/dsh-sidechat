import type { Context } from '@deepseek-ai/cordis'
import { foldSurface, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'

/** One model-visible message projected from a stable session prefix. */
export type SnapshotMessage = NonNullable<ReturnType<Session['deriveEventMessage']>>

/** One committed, model-visible message observed in the currently open turn. */
export interface CurrentTurnMessage {
  /** Event sequence at which this message became visible. */
  readonly seq: number
  /** Exact message projected by DSH, without the surrounding event metadata. */
  readonly message: SnapshotMessage
}

/** A point-in-time, read-only observation of the parent's currently open turn. */
export interface CurrentTurnSnapshot {
  /** Whether a `turn/start` exists after the latest stable boundary. */
  readonly status: 'idle' | 'running'
  /** Open turn number, or null while the parent is between turns. */
  readonly turn: number | null
  /** Sequence of the open `turn/start`, or null while idle. */
  readonly startSeq: number | null
  /** Last committed parent sequence included by this observation. */
  readonly captureSeq: number | null
  /** Number of committed events in the open turn, including non-message events. */
  readonly eventCount: number
  /** Append-origin model messages; internal/log-only events are omitted. */
  readonly messages: readonly CurrentTurnMessage[]
}

/** Immutable stable fork prefix plus a frozen open-turn observation. */
export interface StableSnapshot {
  /** Stable identity for this parent, closed boundary, and observation point. */
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
  /** Frozen observation of committed, visible messages in the open turn. */
  readonly currentTurn: CurrentTurnSnapshot
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
 * Capture an immutable closed-turn prefix plus the open turn at one sequence.
 *
 * The closed prefix remains suitable for a native fork seed. The open turn is
 * kept separately as an observation packet: only append-origin, model-visible
 * messages are retained, so request headers, chunks, command lifecycle data,
 * and other internal events never enter the packet. Returned arrays are
 * detached from the Session, so future parent activity cannot change it.
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
  const tail = sourceEvents.slice((boundary?.seq ?? -1) + 1)
  const activeTurn = tail.findLast(event => event.type === 'turn/start') as SessionEvent<'turn/start'> | undefined
  const currentEvents = activeTurn === undefined
    ? []
    : sourceEvents.slice(activeTurn.seq)
  const currentMessages = currentEvents
    .filter(isAppendSurfaceEvent)
    .map((event): CurrentTurnMessage | null => {
      const message = session.deriveEventMessage(event)
      return message === null ? null : Object.freeze({ seq: event.seq, message })
    })
    .filter((entry): entry is CurrentTurnMessage => entry !== null)
  const currentTurn: CurrentTurnSnapshot = Object.freeze({
    status: activeTurn === undefined ? 'idle' : 'running',
    turn: activeTurn?.data.turn ?? null,
    startSeq: activeTurn?.seq ?? null,
    captureSeq: sourceLastSeq,
    eventCount: currentEvents.length,
    messages: Object.freeze(currentMessages),
  })

  return Object.freeze({
    id: `sidechat:${String(session.id)}:stable-${boundary?.seq ?? 'empty'}:capture-${sourceLastSeq ?? 'empty'}`,
    sessionId: String(session.id),
    sourceLastSeq,
    boundarySeq: boundary?.seq ?? null,
    turn: boundary?.data.turn ?? null,
    turnEndReason: boundary?.data.reason ?? null,
    events: Object.freeze(prefix),
    messages: Object.freeze(messages),
    currentTurn,
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
    /** Stable parent-session snapshot provider installed by dsh-parallel-chat. */
    sideChatSnapshots: StableSnapshotService
  }
}

/** Install the scoped Side Chat snapshot service into a Cordis context. */
export function installStableSnapshotService(ctx: Context): StableSnapshotService {
  const service = new StableSnapshotService(ctx)
  ctx.provide('sideChatSnapshots', service)
  return service
}
