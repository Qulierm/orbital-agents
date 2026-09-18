/**
 * Pure cutover helpers for the C2B atomic switch: canonical peer plan state,
 * relay construction, outbox checkpoint/settle, plan lookup, and single-fact
 * delivery through the authorized transport.
 *
 * These functions do not touch the service's public create/report behavior;
 * C2B wires them in. Keeping them pure makes the switch small and testable.
 */

import {
  createPlanState,
  markDeliveryDelivered,
  markDeliveryPending,
  planChallengerId,
  type PlanDelivery,
  type PlanId,
  type PlanState,
  type TaskSpec,
} from './domain.js'
import type { PeerState } from './peer.js'
import { PeerError } from './peer.js'
import { aggregateReviewRequest, wholePlanBrief } from './peer-briefs.js'
import { authorizePeerRelay, deliverPeerRelay, type PeerDeliveryLedger, type PeerDeliveryQueue, type PeerRelay } from './peer-transport.js'
import type { PeerHostSeam } from './peer-host.js'

/** Canonical plan state for a new peer plan (no child lineage). */
export function createPeerPlanState(input: {
  readonly planId: PlanId
  readonly pair: PeerState
  readonly title: string
  readonly tasks: readonly TaskSpec[]
  readonly at: number
  /** Private briefing inputs persisted for restart-safe plan-ready rebuilds. */
  readonly brief?: string
  readonly constraints?: string
}): PlanState {
  return createPlanState({
    planId: input.planId,
    rootSessionId: input.pair.endeavourSessionId,
    challengerSessionId: input.pair.challengerSessionId,
    pairId: input.pair.pairId,
    title: input.title,
    tasks: input.tasks,
    at: input.at,
    ...(input.brief === undefined ? {} : { executionBrief: input.brief }),
    ...(input.constraints === undefined ? {} : { planConstraints: input.constraints }),
  })
}

/** Whole-plan briefing body for the plan-ready relay. */
export function planReadyBody(input: {
  readonly title: string
  readonly brief: string
  readonly constraints?: string
  readonly tasks: readonly TaskSpec[]
}): string {
  return wholePlanBrief(input.title, input.brief, input.constraints, input.tasks)
}

/**
 * Rebuild the plan-ready body from DURABLE plan state alone: used by restart
 * reconciliation, so the private brief/constraints fields must be present for
 * peer plans (legacy plans without them rebuild from title + tasks).
 */
export function planReadyBodyFromPlan(plan: PlanState): string {
  return wholePlanBrief(
    plan.title,
    plan.executionBrief ?? '',
    plan.planConstraints,
    plan.tasks.map((task) => task.spec),
  )
}

/** Ordered aggregate evidence body for the review-ready relay. */
export function reviewReadyBody(plan: PlanState, blocked: boolean): string {
  return aggregateReviewRequest(plan, blocked)
}

/** Durable delivery key for one protocol relay of one plan. */
export function deliveryKey(pairId: string, planId: string, kind: PlanDelivery['kind']): string {
  return `${pairId}:${planId}:${kind}`
}

function relay(pair: PeerState, plan: PlanState, kind: PlanDelivery['kind'], body: string): PeerRelay {
  const fromEndeavour = kind === 'plan-ready'
  return {
    pairId: pair.pairId,
    planId: plan.planId,
    messageKind: kind,
    senderRole: fromEndeavour ? 'endeavour' : 'challenger',
    senderSessionId: fromEndeavour ? pair.endeavourSessionId : pair.challengerSessionId,
    targetSessionId: fromEndeavour ? pair.challengerSessionId : pair.endeavourSessionId,
    body,
  }
}

/** The plan-ready relay carrying the whole plan to the persistent Challenger. */
export function planReadyRelay(pair: PeerState, plan: PlanState, body: string): PeerRelay {
  return relay(pair, plan, 'plan-ready', body)
}

/** The single review-ready relay carrying the ordered aggregate to Endeavour. */
export function reviewReadyRelay(pair: PeerState, plan: PlanState, body: string): PeerRelay {
  return relay(pair, plan, 'review-ready', body)
}

/** Checkpoint a relay as pending BEFORE any transport attempt (crash-safe). */
export function checkpointOutbox(plan: PlanState, relay: PeerRelay, at: number): PlanState {
  return markDeliveryPending(plan, {
    kind: relay.messageKind,
    key: deliveryKey(relay.pairId, relay.planId, relay.messageKind),
    at,
    targetSessionId: relay.targetSessionId,
  }, at)
}

/** Settle a delivered relay with its transport receipt. */
export function settleOutbox(plan: PlanState, relay: PeerRelay, receipt: string | undefined, at: number): PlanState {
  return markDeliveryDelivered(plan, deliveryKey(relay.pairId, relay.planId, relay.messageKind), receipt, at)
}

/** The canonical plan a Challenger session owns, if any. */
export function planForChallenger(plans: Iterable<PlanState>, sessionId: string): PlanState | undefined {
  for (const plan of plans) {
    if (plan.challengerSessionId === undefined) continue
    if (planChallengerId(plan) === sessionId) return plan
  }
  return undefined
}

/** The newest plan of one pair, in insertion order, if any. */
export function planForPair(plans: Iterable<PlanState>, pairId: string): PlanState | undefined {
  let newest: PlanState | undefined
  for (const plan of plans) {
    if (plan.pairId === pairId) newest = plan
  }
  return newest
}

/** Delivery dependencies for one outbox fact. */
export interface OutboxRuntime {
  readonly seam: PeerHostSeam
  readonly queue: PeerDeliveryQueue
  readonly ledger: PeerDeliveryLedger
  readonly readPair: (sessionId: string) => PeerState | undefined
}

/** Outcome of one outbox delivery attempt. */
export interface OutboxOutcome {
  readonly plan: PlanState
  readonly delivered: boolean
  /** Durable receipt written on success. */
  readonly receipt?: string
}

/**
 * Deliver ONE pending outbox fact through the authorized transport and settle
 * it on success; a failure leaves the fact pending and retryable. A fact that
 * is already delivered is never re-sent.
 */
export async function deliverOutboxFact(
  runtime: OutboxRuntime,
  plan: PlanState,
  relay: PeerRelay,
  fact: PlanDelivery,
): Promise<OutboxOutcome> {
  const problems = authorizePeerRelay(runtime.readPair(relay.senderSessionId), relay)
  if (problems.length > 0) throw new PeerError('peer-unauthorized', problems.join('; '))
  if (fact.status === 'delivered') return { plan, delivered: false }
  const result = await deliverPeerRelay(
    { seam: runtime.seam, readPair: runtime.readPair },
    runtime.queue,
    runtime.ledger,
    relay,
  )
  if (!result.delivered) return { plan, delivered: false }
  return { plan: settleOutbox(plan, relay, result.dedupeKey, fact.at), delivered: true, receipt: result.dedupeKey }
}
