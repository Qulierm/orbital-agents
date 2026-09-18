/**
 * C2A cutover-helper regressions: canonical peer plan state, relay bodies,
 * outbox checkpoint/settle/deliver, pair isolation, cold resume, failure
 * retry, and the service-level peer runtime injection. No public plan
 * behavior changes are asserted here.
 */

import { describe, expect, it } from 'vitest'
import {
  challengerSessionIdFor,
  PeerError,
  peerPairIdFor,
  type PeerState,
} from '../src/peer.js'
import type { PeerAgentFace, PeerHostSeam, PeerSessionMeta } from '../src/peer-host.js'
import { PeerDeliveryLedger, PeerDeliveryQueue } from '../src/peer-transport.js'
import {
  checkpointOutbox,
  createPeerPlanState,
  deliverOutboxFact,
  deliveryKey,
  planForChallenger,
  planForPair,
  planReadyBody,
  planReadyRelay,
  reviewReadyBody,
  reviewReadyRelay,
  settleOutbox,
  type OutboxRuntime,
} from '../src/peer-cutover.js'
import {
  deliveryFact,
  isLegacyChildPlan,
  PlanId,
  planChallengerId,
  TaskId,
  verifyTask,
  reportTask,
  startTask,
  type PlanState,
  type TaskSpec,
} from '../src/domain.js'

function spec(id: string): TaskSpec {
  return { id: TaskId(id), display: { title: id }, execution: { instructions: `do ${id}`, validation: `check ${id}` } }
}

function pairFor(root: string): PeerState {
  return {
    version: 1,
    pairId: peerPairIdFor(root),
    endeavourSessionId: root,
    challengerSessionId: challengerSessionIdFor(root),
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

interface PairRuntime {
  runtime: OutboxRuntime
  pair: PeerState
  agents: Map<string, PeerAgentFace & { inbox: unknown[] }>
  creates: string[]
  failures: Set<string>
}

function pairRuntime(root: string): PairRuntime {
  const pair = pairFor(root)
  const sessions = new Map<string, PeerSessionMeta>([
    [pair.endeavourSessionId, { id: pair.endeavourSessionId, agentPreset: 'endeavour' }],
    [pair.challengerSessionId, { id: pair.challengerSessionId, agentPreset: 'challenger' }],
  ])
  const agents = new Map<string, PeerAgentFace & { inbox: unknown[] }>()
  const creates: string[] = []
  const failures = new Set<string>()
  const seam: PeerHostSeam = {
    listSessionIds: () => [...sessions.keys()],
    sessionMeta: (id) => sessions.get(id),
    createOrdinarySession: async (input) => {
      creates.push(input.id)
      sessions.set(input.id, { id: input.id, agentPreset: input.agentPreset })
      return { sessionId: input.id, adopted: false }
    },
    resolveAgent: async (id) => (failures.has(id) ? undefined : agents.get(id)),
  }
  return {
    pair,
    agents,
    creates,
    failures,
    runtime: {
      seam,
      queue: new PeerDeliveryQueue(),
      ledger: new PeerDeliveryLedger(),
      readPair: () => pair,
    },
  }
}

function peerPlan(runtime: PairRuntime, title = 'Plan'): PlanState {
  return createPeerPlanState({
    planId: PlanId(`plan-${title}`),
    pair: runtime.pair,
    title,
    tasks: [spec('t1'), spec('t2')],
    at: 10,
  })
}

describe('canonical peer plan state', () => {
  it('carries the pair ownership and no legacy child lineage', () => {
    const runtime = pairRuntime('session-root')
    const plan = peerPlan(runtime)
    expect(plan.challengerSessionId).toBe(runtime.pair.challengerSessionId)
    expect(plan.pairId).toBe(runtime.pair.pairId)
    expect(plan.childId).toBeUndefined()
    expect(isLegacyChildPlan(plan)).toBe(false)
    expect(planChallengerId(plan)).toBe(runtime.pair.challengerSessionId)
    expect(planForChallenger([plan], runtime.pair.challengerSessionId)?.planId).toBe(plan.planId)
    expect(planForChallenger([plan], 'session-other')).toBeUndefined()
    expect(planForPair([plan], runtime.pair.pairId)?.planId).toBe(plan.planId)
    expect(planForPair([plan], 'pair-other')).toBeUndefined()
  })

  it('builds the plan-ready body with every task and the review-aggregate body in order', () => {
    const runtime = pairRuntime('session-root')
    const plan = peerPlan(runtime)
    const planBody = planReadyBody({ title: 'Plan', brief: 'brief', constraints: 'c', tasks: [spec('t1'), spec('t2')] })
    expect(planBody).toContain('Task 1 [t1]')
    expect(planBody).toContain('Task 2 [t2]')
    expect(planBody).toContain('continue DIRECTLY with the next task')
    let reported = startTask(plan, TaskId('t1'), 11)
    reported = reportTask(reported, TaskId('t1'), { summary: 'first', files: ['a.ts'], validation: 'ok' }, 12)
    reported = startTask(reported, TaskId('t2'), 13)
    reported = reportTask(reported, TaskId('t2'), { summary: 'second', files: [], validation: 'ok' }, 14)
    const reviewBody = reviewReadyBody(reported, false)
    expect(reviewBody).toContain('all 2 tasks')
    expect(reviewBody.indexOf('first')).toBeLessThan(reviewBody.indexOf('second'))
    expect(reviewBody).toContain('endeavour_verify')
  })

  it('isolates two independent pairs and rejects cross-pair relays', async () => {
    const a = pairRuntime('session-root-a')
    const b = pairRuntime('session-root-b')
    const planA = peerPlan(a, 'A')
    expect(planForChallenger([planA], b.pair.challengerSessionId)).toBeUndefined()
    const relay = planReadyRelay(a.pair, planA, 'body')
    const other = { ...relay, pairId: b.pair.pairId }
    const fact = { kind: 'plan-ready' as const, key: deliveryKey(b.pair.pairId, planA.planId, 'plan-ready'), status: 'pending' as const, at: 1, targetSessionId: b.pair.challengerSessionId }
    await expect(deliverOutboxFact(b.runtime, planA, other, fact)).rejects.toBeInstanceOf(PeerError)
  })
})

describe('outbox delivery', () => {
  it('checkpoints pending, delivers once, settles with a receipt, and never resends', async () => {
    const runtime = pairRuntime('session-root')
    const plan = peerPlan(runtime)
    const body = planReadyBody({ title: 'Plan', brief: 'brief', tasks: [spec('t1'), spec('t2')] })
    const relay = planReadyRelay(runtime.pair, plan, body)
    const pending = checkpointOutbox(plan, relay, 20)
    const key = deliveryKey(relay.pairId, plan.planId, 'plan-ready')
    expect(deliveryFact(pending, key)?.status).toBe('pending')

    const inbox: unknown[] = []
    runtime.agents.set(runtime.pair.challengerSessionId, { inbox, followup: (message) => { inbox.push(message) }, send: () => undefined })
    const first = await deliverOutboxFact(runtime.runtime, pending, relay, deliveryFact(pending, key)!)
    expect(first.delivered).toBe(true)
    expect(deliveryFact(first.plan, key)?.status).toBe('delivered')
    expect(inbox).toHaveLength(1)
    const second = await deliverOutboxFact(runtime.runtime, first.plan, relay, deliveryFact(first.plan, key)!)
    expect(second.delivered).toBe(false)
    expect(inbox).toHaveLength(1)
    expect(settleOutbox(first.plan, relay, 'other', 30)).toBe(first.plan)
  })

  it('keeps the fact pending and retryable on transport failure, and resumes a cold peer', async () => {
    const runtime = pairRuntime('session-root')
    const plan = peerPlan(runtime)
    const relay = planReadyRelay(runtime.pair, plan, 'body')
    const key = deliveryKey(relay.pairId, plan.planId, 'plan-ready')
    const pending = checkpointOutbox(plan, relay, 20)
    // No live Agent yet: a real resolution failure leaves the outbox pending.
    runtime.failures.add(runtime.pair.challengerSessionId)
    await expect(deliverOutboxFact(runtime.runtime, pending, relay, deliveryFact(pending, key)!))
      .rejects.toMatchObject({ code: 'peer-target-unreachable' })
    expect(deliveryFact(pending, key)?.status).toBe('pending')
    // The peer resumes (cold start) and the SAME pending fact delivers.
    runtime.failures.delete(runtime.pair.challengerSessionId)
    const inbox: unknown[] = []
    runtime.agents.set(runtime.pair.challengerSessionId, { inbox, followup: (message) => { inbox.push(message) }, send: () => undefined })
    const retry = await deliverOutboxFact(runtime.runtime, pending, relay, deliveryFact(pending, key)!)
    expect(retry.delivered).toBe(true)
    expect(deliveryFact(retry.plan, key)?.status).toBe('delivered')
    expect(inbox).toHaveLength(1)
  })

  it('sends exactly one review-ready aggregate after the last report', async () => {
    const runtime = pairRuntime('session-root')
    const plan = peerPlan(runtime)
    let state = startTask(plan, TaskId('t1'), 11)
    state = reportTask(state, TaskId('t1'), { summary: 'a', files: [], validation: 'ok' }, 12)
    state = startTask(state, TaskId('t2'), 13)
    state = reportTask(state, TaskId('t2'), { summary: 'b', files: [], validation: 'ok' }, 14)
    const relay = reviewReadyRelay(runtime.pair, state, reviewReadyBody(state, false))
    expect(relay.senderRole).toBe('challenger')
    expect(relay.targetSessionId).toBe(runtime.pair.endeavourSessionId)
    const pending = checkpointOutbox(state, relay, 15)
    const inbox: unknown[] = []
    runtime.agents.set(runtime.pair.endeavourSessionId, { inbox, followup: (message) => { inbox.push(message) }, send: () => undefined })
    const outcome = await deliverOutboxFact(runtime.runtime, pending, relay, deliveryFact(pending, deliveryKey(relay.pairId, state.planId, 'review-ready'))!)
    expect(outcome.delivered).toBe(true)
    expect(inbox).toHaveLength(1)
    // Endeavour confirms one task — the review relay never runs in reverse.
    const confirmed = verifyTask(outcome.plan, TaskId('t1'), 'succeeded', 'ok', 16)
    expect(confirmed.terminal).toBeUndefined()
    expect(inbox).toHaveLength(1)
  })
})
