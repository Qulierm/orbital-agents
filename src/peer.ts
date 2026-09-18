/**
 * Persistent peer pair domain.
 *
 * One logical user session is represented by TWO ordinary, non-subagent
 * sessions: an Endeavour root and its deterministic Challenger companion. The
 * pair is durable (`endeavour/peer` checkpoints), created once per Endeavour
 * session, and reused by every later plan. Nothing here spawns, addresses, or
 * references a subagent.
 */

import { createHash, randomUUID } from 'node:crypto'

/** Durable event type carrying peer-pair checkpoints. */
export const PEER_EVENT_TYPE = 'endeavour/peer'

/** Role of one member of a pair. */
export type PeerRole = 'endeavour' | 'challenger'

/** Current durable pair schema version. */
export const PEER_STATE_VERSION = 1

/** Durable state of one logical (Endeavour + Challenger) pair. */
export interface PeerState {
  readonly version: typeof PEER_STATE_VERSION
  readonly pairId: string
  readonly endeavourSessionId: string
  readonly challengerSessionId: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Monotonic checkpoint sequence within the pair. */
  readonly sequence: number
}

/** Transition kinds persisted inside every peer checkpoint. */
export type PeerEventKind = 'peer-created' | 'peer-updated'

/** Durable payload of one `endeavour/peer` event. */
export interface PeerEventPayload {
  readonly kind: PeerEventKind
  readonly at: number
  readonly plan: PeerState
}

/** Errors raised by peer validation. */
export class PeerError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PeerError'
    this.code = code
  }
}

/**
 * Deterministic Challenger session id for one Endeavour session.
 *
 * Stable across restarts/HMR (crash-safe idempotent adoption) and collision-safe
 * because it is a UUID-v5-shaped hash of the full Endeavour id.
 */
export function challengerSessionIdFor(endeavourSessionId: string): string {
  if (endeavourSessionId === '') throw new PeerError('peer-invalid', 'endeavour session id must not be empty')
  const hex = createHash('sha256').update(`dsh-endeavour/challenger:${endeavourSessionId}`).digest('hex')
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
  const prefix = endeavourSessionId.startsWith('session-') ? 'session-' : 'challenger-'
  return `${prefix}${uuid}`
}

/** Deterministic pair identity derived from the Endeavour side. */
export function peerPairIdFor(endeavourSessionId: string): string {
  return `pair-${challengerSessionIdFor(endeavourSessionId).replace(/^session-/, '')}`
}

/** Input of one pair creation. */
export interface PeerCreation {
  readonly endeavourSessionId: string
  readonly at: number
}

/** Create the durable pair for one Endeavour session. */
export function createPeerState(input: PeerCreation): PeerState {
  const challengerSessionId = challengerSessionIdFor(input.endeavourSessionId)
  if (challengerSessionId === input.endeavourSessionId) {
    throw new PeerError('peer-collision', 'derived challenger id collides with the Endeavour id')
  }
  return {
    version: PEER_STATE_VERSION,
    pairId: peerPairIdFor(input.endeavourSessionId),
    endeavourSessionId: input.endeavourSessionId,
    challengerSessionId,
    createdAt: input.at,
    updatedAt: input.at,
    sequence: 1,
  }
}

/** Validate one pair state strictly: exact reciprocal ids and role identity. */
export function validatePeerState(state: PeerState | undefined): readonly string[] {
  if (state === undefined) return ['missing peer state']
  const problems: string[] = []
  if (state.version !== PEER_STATE_VERSION) problems.push(`unsupported peer version ${String(state.version)}`)
  if (state.endeavourSessionId === '') problems.push('missing endeavourSessionId')
  if (state.challengerSessionId === '') problems.push('missing challengerSessionId')
  if (state.endeavourSessionId === state.challengerSessionId) problems.push('pair members must be distinct sessions')
  if (state.challengerSessionId !== challengerSessionIdFor(state.endeavourSessionId)) {
    problems.push('challengerSessionId is not the deterministic companion of the Endeavour session')
  }
  if (state.pairId !== peerPairIdFor(state.endeavourSessionId)) problems.push('pairId does not match the Endeavour session')
  if (state.sequence < 1) problems.push('sequence must be positive')
  return problems
}

/** Role of one session inside a pair, or undefined when unpaired. */
export function peerRoleOf(state: PeerState | undefined, sessionId: string): PeerRole | undefined {
  if (state === undefined) return undefined
  if (state.endeavourSessionId === sessionId) return 'endeavour'
  if (state.challengerSessionId === sessionId) return 'challenger'
  return undefined
}

/** The other member of the pair, when the session belongs to it. */
export function peerOf(state: PeerState | undefined, sessionId: string): string | undefined {
  const role = peerRoleOf(state, sessionId)
  if (role === undefined) return undefined
  return role === 'endeavour' ? state?.challengerSessionId : state?.endeavourSessionId
}

/** Build one durable checkpoint payload. */
export function peerEventPayload(
  kind: PeerEventKind,
  _previous: PeerState | undefined,
  state: PeerState,
  at: number,
): PeerEventPayload {
  return { kind, at, plan: state }
}

/** Fold peer checkpoints into the newest valid pair state. */
export function foldPeerEvents(events: readonly PeerEventPayload[]): PeerState | undefined {
  let newest: PeerState | undefined
  for (const event of events) {
    const candidate = event?.plan
    if (candidate === undefined) continue
    if (newest !== undefined && candidate.sequence <= newest.sequence) continue
    newest = candidate
  }
  return newest === undefined || validatePeerState(newest).length > 0 ? newest : newest
}

/** A pair registry indexing both ordinary sides. */
export class PeerRegistry {
  private readonly bySession = new Map<string, PeerState>()

  /** Index (or adopt) one pair, rejecting invalid states. */
  set(state: PeerState): PeerState {
    const problems = validatePeerState(state)
    if (problems.length > 0) throw new PeerError('peer-invalid', problems.join('; '))
    this.bySession.set(state.endeavourSessionId, state)
    this.bySession.set(state.challengerSessionId, state)
    return state
  }

  /** Pair state seen from either side. */
  get(sessionId: string): PeerState | undefined {
    return this.bySession.get(sessionId)
  }

  /** Role of one member. */
  roleOf(sessionId: string): PeerRole | undefined {
    return peerRoleOf(this.get(sessionId), sessionId)
  }

  /** The other member's id, when the session is paired. */
  peerOf(sessionId: string): string | undefined {
    return peerOf(this.get(sessionId), sessionId)
  }

  /** True when the session belongs to any pair. */
  has(sessionId: string): boolean {
    return this.bySession.has(sessionId)
  }

  /** All distinct pairs. */
  pairs(): readonly PeerState[] {
    return [...new Set(this.bySession.values())]
  }
}

/** Random durable id helper for transport receipts (not a session id). */
export function peerReceiptId(): string {
  return randomUUID()
}
