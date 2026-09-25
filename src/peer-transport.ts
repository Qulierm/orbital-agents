/**
 * Typed durable peer transport between the two ordinary sessions of one pair.
 *
 * Messages carry an explicit `endeavour-peer` source (never human
 * impersonation) and are delivered through the recipient's own Agent inbox so
 * cold resumes and idle wakeups behave like any other ordinary message.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PeerError, validatePeerState, type PeerRole, type PeerState } from './peer.js'
import type { PeerAgentFace, PeerHostSeam } from './peer-host.js'

/** Kinds the durable protocol uses. */
export type PeerMessageKind = 'plan-ready' | 'review-ready'

/** One authorized relay between the two members of a pair. */
export interface PeerRelay {
  readonly pairId: string
  readonly planId: string
  readonly messageKind: PeerMessageKind
  readonly senderRole: PeerRole
  readonly senderSessionId: string
  readonly targetSessionId: string
  readonly body: string
}

declare module '@deepseek-ai/dsh-llm/message' {
  interface MessageSourceMap {
    /** One durable peer relay between an Endeavour/Challenger pair. */
    'endeavour-peer': {
      readonly kind: 'endeavour-peer'
      readonly form: 'relay'
      readonly pairId: string
      readonly planId: string
      readonly messageKind: PeerMessageKind
      readonly senderRole: PeerRole
      readonly senderSessionId: string
    }
  }
}

/** Authorization problems; empty means the relay may be delivered. */
export function authorizePeerRelay(pair: PeerState | undefined, relay: PeerRelay): readonly string[] {
  const problems: string[] = []
  if (pair === undefined) return ['sender is not part of a pair']
  problems.push(...validatePeerState(pair))
  if (pair.pairId !== relay.pairId) problems.push('relay pairId does not match the durable pair')
  if (relay.planId.trim() === '') problems.push('relay planId must not be empty')
  const role = pair.endeavourSessionId === relay.senderSessionId
    ? 'endeavour'
    : pair.challengerSessionId === relay.senderSessionId
      ? 'challenger'
      : undefined
  if (role === undefined) problems.push('sender does not belong to the pair')
  else if (role !== relay.senderRole) problems.push(`sender role ${relay.senderRole} does not match its session`)
  const expectedTarget = role === 'endeavour' ? pair.challengerSessionId : pair.endeavourSessionId
  if (relay.targetSessionId !== expectedTarget) problems.push('target is not the exact counterpart of the pair')
  if (relay.senderSessionId === relay.targetSessionId) problems.push('a peer cannot send to itself')
  if (relay.senderRole === 'challenger' && relay.messageKind !== 'review-ready') {
    problems.push('only the Endeavour side may send plan-ready')
  }
  return problems
}

/** Model-facing text with explicit attribution (never a bare user message). */
export function peerRelayText(relay: PeerRelay): string {
  const from = relay.senderRole === 'endeavour' ? 'Endeavour' : 'Challenger'
  const to = relay.senderRole === 'endeavour' ? 'Challenger' : 'Endeavour'
  const label = relay.messageKind === 'plan-ready' ? 'plan-ready' : 'review-ready'
  return [
    `${from} → ${to} (peer relay, ${label})`,
    `Pair: ${relay.pairId}`,
    `Plan: ${relay.planId}`,
    '',
    relay.body,
  ].join('\n')
}

/**
 * Durable user-message shape for one relay. `createUserMessage` mints the
 * identity itself and rejects a caller-supplied `id`, so the durable dedupe
 * key stays in `source` instead of the message id.
 */
export function peerRelayMessage(relay: PeerRelay) {
  return createUserMessage({
    content: [{ type: 'text', text: peerRelayText(relay) }],
    source: {
      kind: 'endeavour-peer',
      form: 'relay',
      pairId: relay.pairId,
      planId: relay.planId,
      messageKind: relay.messageKind,
      senderRole: relay.senderRole,
      senderSessionId: relay.senderSessionId,
    },
  } as Parameters<typeof createUserMessage>[0])
}

/** Stable retry key for one protocol step of one plan. */
export function peerDedupeKey(relay: Pick<PeerRelay, 'pairId' | 'planId' | 'messageKind' | 'senderRole'>): string {
  return `${relay.pairId}:${relay.planId}:${relay.messageKind}:${relay.senderRole}`
}

/** FIFO queue: one delivery chain per pair keeps protocol order intact. */
export class PeerDeliveryQueue {
  private readonly chains = new Map<string, Promise<unknown>>()

  enqueue<T>(pairId: string, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(pairId) ?? Promise.resolve()
    const next = previous.then(job, job)
    this.chains.set(pairId, next.catch(() => undefined))
    return next
  }
}

/** Delivery dependencies (host seam + dedupe ledger). */
export interface PeerDeliveryDeps {
  readonly seam: PeerHostSeam
  readonly readPair: (sessionId: string) => PeerState | undefined
  readonly now?: () => number
}

/**
 * In-memory retry ledger. A key is RESERVED before delivery and COMMITTED only
 * on success, so a failed create/resolve/followup+send releases the reservation
 * and a retry can deliver; concurrent identical relays still collapse to one
 * delivery. A process restart clears the ledger (durable plan checkpoints stay
 * authoritative).
 */
export class PeerDeliveryLedger {
  private readonly reservations = new Set<string>()

  reserve(key: string): boolean {
    if (this.reservations.has(key)) return false
    this.reservations.add(key)
    return true
  }

  /** Successful delivery: the reservation stays as the delivered marker. */
  commit(key: string): void {
    this.reservations.add(key)
  }

  /** Failed delivery: free the slot so a retry may attempt again. */
  release(key: string): void {
    this.reservations.delete(key)
  }

  has(key: string): boolean {
    return this.reservations.has(key)
  }
}

/** Result of one delivery attempt. */
export interface PeerDeliveryResult {
  readonly delivered: boolean
  readonly dedupeKey: string
}

/**
 * Deliver one relay through the recipient Agent's own inbox. Authorization and
 * dedupe run before any wakeup; the ledger is in-memory, so a restart may
 * re-deliver — the durable plan checkpoints remain the source of truth.
 */
export async function deliverPeerRelay(
  deps: PeerDeliveryDeps,
  queue: PeerDeliveryQueue,
  ledger: PeerDeliveryLedger,
  relay: PeerRelay,
): Promise<PeerDeliveryResult> {
  const pair = deps.readPair(relay.senderSessionId)
  const problems = authorizePeerRelay(pair, relay)
  if (problems.length > 0) throw new PeerError('peer-unauthorized', problems.join('; '))
  const key = peerDedupeKey(relay)
  return queue.enqueue(relay.pairId, async () => {
    // Reserve before the async create/resolve work so a concurrent identical
    // relay cannot double-deliver; release below when anything fails.
    if (!ledger.reserve(key)) return { delivered: false, dedupeKey: key }
    try {
      // Official resolution resumes a cold persisted peer instead of failing.
      const agent: PeerAgentFace | undefined = await deps.seam.resolveAgent(relay.targetSessionId)
      if (agent === undefined) throw new PeerError('peer-target-unreachable', `could not resolve agent for ${relay.targetSessionId}`)
      const message = peerRelayMessage(relay)
      try {
        agent.followup(message)
      } catch {
        // Busy target: queue as a next-turn message instead.
        agent.send(message, 'next-turn', true)
      }
      ledger.commit(key)
      return { delivered: true, dedupeKey: key }
    } catch (error) {
      ledger.release(key)
      throw error
    }
  })
}
