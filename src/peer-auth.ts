/**
 * Exact peer authorization for the persistent-pair protocol.
 *
 * New runtime paths authorize against the durable `PeerState` (pair identity,
 * reciprocal member ids and the plan's pair ownership). Legacy plans that only
 * carry a continuable `childId` are REJECTED for those paths: they stay
 * readable as history but can never drive new plan-ready/review-ready traffic.
 */

import { PeerError, validatePeerState, type PeerRole, type PeerState } from './peer.js'
import { isLegacyChildPlan, planChallengerId, type PlanState } from './domain.js'

/** The durable pair both ordinary members belong to. */
export interface PlanPair {
  readonly pair: PeerState
  readonly plan: PlanState
}

function authorizedPair(pair: PeerState | undefined): PeerState {
  if (pair === undefined) throw new PeerError('peer-unauthorized', 'session is not part of a durable pair')
  const problems = validatePeerState(pair)
  if (problems.length > 0) throw new PeerError('peer-unauthorized', problems.join('; '))
  return pair
}

/**
 * Assert one session is the Endeavour side of the pair that owns this plan.
 * Rejects cross-pair sessions, the wrong role, and legacy child plans.
 */
export function assertPairedEndeavour(pair: PeerState | undefined, sessionId: string, plan: PlanState | undefined): PlanPair {
  const state = authorizedPair(pair)
  if (state.endeavourSessionId !== sessionId) {
    throw new PeerError('peer-unauthorized', `session ${sessionId} is not the Endeavour side of pair ${state.pairId}`)
  }
  if (plan === undefined) return { pair: state, plan: undefined as never }
  return { pair: state, plan: assertPlanOwnership(state, 'endeavour', plan) }
}

/** Assert one session is the Challenger side of the pair that owns this plan. */
export function assertPairedChallenger(pair: PeerState | undefined, sessionId: string, plan: PlanState | undefined): PlanPair {
  const state = authorizedPair(pair)
  if (state.challengerSessionId !== sessionId) {
    throw new PeerError('peer-unauthorized', `session ${sessionId} is not the Challenger side of pair ${state.pairId}`)
  }
  if (plan === undefined) return { pair: state, plan: undefined as never }
  return { pair: state, plan: assertPlanOwnership(state, 'challenger', plan) }
}

/** Shared plan-ownership checks, rejecting legacy child plans for peer paths. */
function assertPlanOwnership(state: PeerState, role: PeerRole, plan: PlanState): PlanState {
  if (isLegacyChildPlan(plan)) {
    throw new PeerError('peer-legacy-plan', `plan ${plan.planId} predates persistent peers and cannot use peer traffic`)
  }
  if (plan.pairId !== undefined && plan.pairId !== state.pairId) {
    throw new PeerError('peer-unauthorized', `plan ${plan.planId} belongs to another pair`)
  }
  if (plan.rootSessionId !== state.endeavourSessionId) {
    throw new PeerError('peer-unauthorized', `plan ${plan.planId} is not owned by pair ${state.pairId}`)
  }
  if (planChallengerId(plan) !== state.challengerSessionId) {
    throw new PeerError('peer-unauthorized', `plan ${plan.planId} names a different executor`)
  }
  void role
  return plan
}

/** Role of one session inside a validated pair, or undefined when unpaired. */
export function pairedRoleOf(pair: PeerState | undefined, sessionId: string): PeerRole | undefined {
  if (pair === undefined) return undefined
  if (pair.endeavourSessionId === sessionId) return 'endeavour'
  if (pair.challengerSessionId === sessionId) return 'challenger'
  return undefined
}
