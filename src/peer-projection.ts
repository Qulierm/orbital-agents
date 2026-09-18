/**
 * Shared peer projection: one pure fold from durable `endeavour/peer`
 * checkpoints to a renderer payload, plus the per-session role/counterpart
 * derivation both members read. No subagent concepts anywhere.
 */

import { foldPeerEvents, validatePeerState, type PeerEventPayload, type PeerRole, type PeerState } from './peer.js'

/** Renderer-facing role view of one pair member. */
export interface PeerView {
  readonly version: number
  readonly pairId: string
  readonly role: PeerRole
  readonly sessionId: string
  readonly counterpartId: string
  readonly endeavourSessionId: string
  readonly challengerSessionId: string
}

/** Accept a durable checkpoint only when it validates exactly. */
export function projectPeerState(value: unknown): PeerState | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as PeerState
  if (typeof candidate.pairId !== 'string' || typeof candidate.endeavourSessionId !== 'string') return null
  if (typeof candidate.challengerSessionId !== 'string') return null
  return validatePeerState(candidate).length === 0 ? candidate : null
}

/**
 * Role view for ONE member. Both sides project the same validated PeerState;
 * each derives its own role and counterpart from it.
 */
export function peerView(state: PeerState | null | undefined, sessionId: string): PeerView | null {
  if (state === null || state === undefined) return null
  if (sessionId === state.endeavourSessionId) {
    return {
      version: state.version,
      pairId: state.pairId,
      role: 'endeavour',
      sessionId,
      counterpartId: state.challengerSessionId,
      endeavourSessionId: state.endeavourSessionId,
      challengerSessionId: state.challengerSessionId,
    }
  }
  if (sessionId === state.challengerSessionId) {
    return {
      version: state.version,
      pairId: state.pairId,
      role: 'challenger',
      sessionId,
      counterpartId: state.endeavourSessionId,
      endeavourSessionId: state.endeavourSessionId,
      challengerSessionId: state.challengerSessionId,
    }
  }
  return null
}

/** Latest validated peer view for one member from a replayed event tail. */
export function latestPeerView(events: readonly PeerEventPayload[], sessionId: string): PeerView | null {
  return peerView(foldPeerEvents(events) ?? null, sessionId)
}
