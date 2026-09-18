/**
 * C1 peer authorization + delivery-outbox regressions. Legacy plans must stay
 * readable but are rejected for every new peer path.
 */

import { describe, expect, it } from 'vitest'
import {
  createPlanState,
  deliveryFact,
  isLegacyChildPlan,
  markDeliveryDelivered,
  markDeliveryPending,
  pendingDeliveries,
  PlanId,
  planChallengerId,
  TaskId,
  type PlanState,
  type TaskSpec,
} from '../src/domain.js'
import { challengerSessionIdFor, PeerError, peerPairIdFor, type PeerState } from '../src/peer.js'
import { assertPairedChallenger, assertPairedEndeavour, pairedRoleOf } from '../src/peer-auth.js'
import { projectPlanCard } from '../src/plan-projection.js'

function spec(id: string): TaskSpec {
  return { id: TaskId(id), display: { title: id }, execution: { instructions: `do ${id}`, validation: `check ${id}` } }
}

function pairFor(root: string): PeerState {
  const challenger = challengerSessionIdFor(root)
  return {
    version: 1,
    pairId: peerPairIdFor(root),
    endeavourSessionId: root,
    challengerSessionId: challenger,
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

function peerPlan(pair: PeerState): PlanState {
  return createPlanState({
    planId: PlanId('p1'),
    rootSessionId: pair.endeavourSessionId,
    challengerSessionId: pair.challengerSessionId,
    pairId: pair.pairId,
    title: 'Plan',
    tasks: [spec('t1')],
    at: 0,
  })
}

describe('peer authorization', () => {
  it('accepts the exact reciprocal members of the pair that owns the plan', () => {
    const pair = pairFor('session-root')
    const plan = peerPlan(pair)
    expect(assertPairedEndeavour(pair, 'session-root', plan).plan.planId).toBe('p1')
    expect(assertPairedChallenger(pair, pair.challengerSessionId, plan).pair.pairId).toBe(pair.pairId)
    expect(pairedRoleOf(pair, 'session-root')).toBe('endeavour')
    expect(pairedRoleOf(pair, pair.challengerSessionId)).toBe('challenger')
    expect(pairedRoleOf(pair, 'session-other')).toBeUndefined()
  })

  it('rejects unpaired, cross-pair, wrong-role and mismatched-plan sessions', () => {
    const pair = pairFor('session-root')
    const plan = peerPlan(pair)
    expect(() => assertPairedEndeavour(undefined, 'session-root', plan)).toThrow(PeerError)
    try { assertPairedEndeavour(pair, pair.challengerSessionId, plan); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    try { assertPairedChallenger(pair, 'session-root', plan); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    const other = pairFor('session-other')
    try { assertPairedEndeavour(other, other.endeavourSessionId, plan); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    const foreign = { ...plan, pairId: other.pairId }
    try { assertPairedEndeavour(pair, 'session-root', foreign); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    const wrongExecutor = { ...plan, challengerSessionId: 'session-elsewhere' }
    try { assertPairedEndeavour(pair, 'session-root', wrongExecutor); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    const wrongRoot = { ...plan, rootSessionId: 'session-elsewhere' }
    try { assertPairedEndeavour(pair, 'session-root', wrongRoot); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
    // A corrupt pair is never authorized.
    try { assertPairedEndeavour({ ...pair, challengerSessionId: 'forged' }, 'session-root', plan); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-unauthorized') }
  })

  it('rejects legacy child plans on new peer paths while keeping them readable', () => {
    const legacy = createPlanState({
      planId: PlanId('legacy'),
      rootSessionId: 'session-old',
      childId: 'session-old-child',
      title: 'Legacy',
      tasks: [spec('t1')],
      at: 0,
    })
    expect(isLegacyChildPlan(legacy)).toBe(true)
    expect(planChallengerId(legacy)).toBe('session-old-child')
    const pair = pairFor('session-old')
    try { assertPairedEndeavour(pair, 'session-old', legacy); expect.unreachable() } catch (error) { expect((error as PeerError).code).toBe('peer-legacy-plan') }
    // The historical card still projects with the legacy fallback.
    const card = projectPlanCard(legacy)
    expect(card.childId).toBe('session-old-child')
    expect(card.challengerSessionId).toBeUndefined()
    // A peer plan projects the canonical ids instead.
    const peer = projectPlanCard(peerPlan(pair))
    expect(peer.challengerSessionId).toBe(pair.challengerSessionId)
    expect(peer.pairId).toBe(pair.pairId)
  })
})

describe('delivery outbox', () => {
  it('checkpoints pending before delivery and settles with a receipt', () => {
    const pair = pairFor('session-root')
    const plan = peerPlan(pair)
    const key = `${pair.pairId}:p1:plan-ready`
    const pending = markDeliveryPending(plan, { kind: 'plan-ready', key, at: 5, targetSessionId: pair.challengerSessionId }, 5)
    expect(deliveryFact(pending, key)?.status).toBe('pending')
    expect(pendingDeliveries(pending)).toHaveLength(1)
    // Re-checkpointing an already delivered relay is a no-op.
    const settled = markDeliveryDelivered(pending, key, 'receipt-1', 6)
    expect(deliveryFact(settled, key)).toMatchObject({ status: 'delivered', receipt: 'receipt-1', at: 6 })
    expect(pendingDeliveries(settled)).toHaveLength(0)
    expect(markDeliveryPending(settled, { kind: 'plan-ready', key, at: 7, targetSessionId: pair.challengerSessionId }, 7)).toBe(settled)
    expect(markDeliveryDelivered(settled, key, 'receipt-2', 8).deliveries?.[0]?.receipt).toBe('receipt-1')
    expect(() => markDeliveryDelivered(plan, 'missing-key', undefined, 9)).toThrow()
  })
})
