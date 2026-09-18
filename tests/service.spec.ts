/**
 * Peer service cutover tests: persistent-pair plan creation, Challenger
 * authorization, two-phase relays, ordered verification, outbox recovery and
 * pair isolation. Everything runs against fakes — no agent is ever created and
 * no model request exists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/cordis', () => ({
  Service: class {
    ctx: unknown
    name: string
    constructor(ctx: unknown, name: string) {
      this.ctx = ctx
      this.name = name
    }
  },
}))

import type { TaskSpec } from '../src/domain.js'
import type { PeerState } from '../src/peer.js'

const { EndeavourService } = await import('../src/service.js')
const { EndeavourError, PlanId, TaskId } = await import('../src/domain.js')
const { challengerSessionIdFor, peerEventPayload, peerPairIdFor, PeerError } = await import('../src/peer.js')
const { PeerDeliveryLedger, PeerDeliveryQueue } = await import('../src/peer-transport.js')
const { PeerProvisioner } = await import('../src/peer-service.js')

function spec(id: string): TaskSpec {
  return { id: TaskId(id), display: { title: id }, execution: { instructions: `do ${id}`, validation: `check ${id}` } }
}

interface FakeEvent { type: string; data: unknown }

function fakeSession(id: string, events: FakeEvent[] = [], preset = 'endeavour') {
  const list = [...events]
  const session = {
    id,
    header: { agentPreset: preset, cwd: '/proj' },
    seq: list.length,
    eventAt: (at: number) => list[at],
    append: (type: string, data: unknown) => { list.push({ type, data }) },
    events: list,
  }
  return session
}

function pairState(rootId: string): PeerState {
  return {
    version: 1,
    pairId: peerPairIdFor(rootId),
    endeavourSessionId: rootId,
    challengerSessionId: challengerSessionIdFor(rootId),
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

interface Harness {
  service: InstanceType<typeof EndeavourService>
  root: ReturnType<typeof fakeSession>
  challenger: ReturnType<typeof fakeSession>
  pair: PeerState
  inbox: Map<string, unknown[]>
  ensureCalls: { sessionId: string }[]
  resolves: { sessionId: string; ok: boolean }[]
  failResolve: Set<string>
  readPair: (sessionId: string) => PeerState | undefined
}

function harness(rootId = 'session-root', seedSecondPair = false): Harness {
  const pair = pairState(rootId)
  const rootEvent = { type: 'endeavour/peer', data: peerEventPayload('peer-created', undefined, pair, 1) }
  const root = fakeSession(rootId, [rootEvent])
  const challenger = fakeSession(pair.challengerSessionId, [rootEvent], 'challenger')
  const sessions = [root, challenger]
  const inbox = new Map<string, unknown[]>([[rootId, []], [pair.challengerSessionId, []]])
  const ensureCalls: { sessionId: string }[] = []
  const resolves: { sessionId: string; ok: boolean }[] = []
  const failResolve = new Set<string>()
  const readPair = (sessionId: string): PeerState | undefined => (sessionId === rootId || sessionId === pair.challengerSessionId ? pair : undefined)
  const seam = {
    listSessionIds: () => sessions.map((session) => session.id),
    sessionMeta: (id: string) => sessions.find((session) => session.id === id)?.header === undefined
      ? undefined
      : { id, agentPreset: sessions.find((session) => session.id === id)!.header.agentPreset },
    createOrdinarySession: async (input: { id: string }) => { void input; return { sessionId: input.id, adopted: false } },
    resolveAgent: async (id: string) => {
      const ok = !failResolve.has(id)
      resolves.push({ sessionId: id, ok })
      if (!ok) return undefined
      const box = inbox.get(id)
      if (box === undefined) return undefined
      return {
        followup: (message: unknown) => { box.push(message) },
        send: (message: unknown) => { box.push(message) },
      }
    },
  }
  const provisioner = new PeerProvisioner({
    seam,
    readPair,
    hasCheckpoint: () => true,
    appendPair: async () => undefined,
    now: () => 1,
  })
  const originalEnsure = provisioner.ensure.bind(provisioner)
  provisioner.ensure = async (sessionId: string) => { ensureCalls.push({ sessionId }); return originalEnsure(sessionId) }
  const ctx = {
    reflect: { provide: () => () => undefined },
    sessions: {
      get: (id: string) => sessions.find((session) => session.id === id),
      flush: async () => true,
      list: () => sessions,
    },
    sessionProjections: { register: () => () => undefined },
  }
  const service = new EndeavourService(ctx as never, {})
  service.setPeerRuntime({ seam, provisioner, queue: new PeerDeliveryQueue(), ledger: new PeerDeliveryLedger() })
  if (seedSecondPair) void 0
  return { service, root, challenger, pair, inbox, ensureCalls, resolves, failResolve, readPair }
}

const rootAgent = (rootId = 'session-root') => ({ session: { id: rootId } })
const challengerAgent = (h: Harness) => ({ session: { id: h.pair.challengerSessionId } })

const planInput = () => ({
  title: 'Plan',
  brief: 'Do the whole thing safely.',
  tasks: [spec('t1'), spec('t2'), spec('t3')],
})

function relays(h: Harness): number {
  return (h.inbox.get(h.pair.challengerSessionId)?.length ?? 0) + (h.inbox.get(h.pair.endeavourSessionId)?.length ?? 0)
}

describe('peer plan creation', () => {
  it('creates one plan, ensures the pair once, and delivers exactly one plan-ready', async () => {
    const h = harness()
    const created = await h.service.createPlan(rootAgent() as never, planInput())
    expect(created.challengerSessionId).toBe(h.pair.challengerSessionId)
    expect(created.taskCount).toBe(3)
    expect(h.ensureCalls).toEqual([{ sessionId: 'session-root' }])
    expect(h.root.events.map((event) => event.type)).toEqual([
      'endeavour/peer', 'endeavour/plan', 'endeavour/plan', 'endeavour/plan',
    ])
    const plan = h.service.getActivePlan('session-root')
    expect(plan?.challengerSessionId).toBe(h.pair.challengerSessionId)
    expect(plan?.pairId).toBe(h.pair.pairId)
    expect(plan?.childId).toBeUndefined()
    // Exactly ONE plan-ready landed on the Challenger inbox.
    expect(h.inbox.get(h.pair.challengerSessionId)).toHaveLength(1)
    expect(JSON.stringify(h.inbox.get(h.pair.challengerSessionId)?.[0])).toContain('Task 3 [t3]')
    // No agent was created and no subagent service exists in the context.
    expect((h.service as unknown as { subagentHost?: unknown }).subagentHost).toBeUndefined()
    await expect(h.service.createPlan(rootAgent() as never, planInput())).rejects.toBeInstanceOf(EndeavourError)
  })

  it('self-heals a genuine Endeavour session before authorizing the first plan', async () => {
    const h = harness()
    // Simulate the race: the durable pair exists in the log but was never
    // indexed (the lifecycle missed the selection), so getPeer is absent.
    // Simulate the race: the durable pair exists in the log but was never
    // indexed, so getPeer is absent when the tool call arrives.
    const internal = h.service as unknown as { peers: { bySession: Map<string, unknown> } }
    const pair = h.pair
    internal.peers.bySession.clear()
    const created = await h.service.createPlan(rootAgent() as never, planInput())
    expect(created.challengerSessionId).toBe(pair.challengerSessionId)
    // Exactly one plan-ready was delivered to the persistent Challenger.
    expect(h.inbox.get(pair.challengerSessionId)).toHaveLength(1)
    // Concurrent first calls converge: one active plan, one peer provision.
    internal.peers.bySession.clear()
    const before = h.ensureCalls.length
    const outcomes = await Promise.allSettled([
      h.service.createPlan(rootAgent() as never, planInput()),
      h.service.createPlan(rootAgent() as never, planInput()),
    ])
    // The already-active plan wins: both calls reject and neither duplicates work.
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    expect(h.ensureCalls.length - before).toBe(1)
  })

  it('never lets a non-Endeavour caller provision a peer through the plan tool', async () => {
    const h = harness()
    const internal = h.service as unknown as { peers: { bySession: Map<string, unknown> } }
    internal.peers.bySession.clear()
    const stranger = { session: { id: 'session-stranger' } }
    // A non-Endeavour caller is rejected by the EXACT authorization path
    // without ever touching the Host provisioning seam.
    await expect(h.service.createPlan(stranger as never, planInput())).rejects.toBeInstanceOf(PeerError)
    expect(h.ensureCalls).toEqual([])
  })

  it('skips an append when the exact checkpoint is already durable on that log', () => {
    const h = harness()
    const internal = h.service as unknown as {
      sessionHasPeerCheckpoint(sessionId: string, state?: PeerState): boolean
    }
    // Present: the log carries this pair at this sequence.
    expect(internal.sessionHasPeerCheckpoint('session-root')).toBe(true)
    expect(internal.sessionHasPeerCheckpoint('session-root', h.pair)).toBe(true)
    // Absent for a NEWER sequence (a real repair must still be written)...
    expect(internal.sessionHasPeerCheckpoint('session-root', { ...h.pair, sequence: h.pair.sequence + 1 })).toBe(false)
    // ...and for a session outside the pair.
    expect(internal.sessionHasPeerCheckpoint('session-unknown')).toBe(false)
    // One checkpoint per log: a re-mount can never append a duplicate.
    expect(h.root.events.filter((event) => event.type === 'endeavour/peer')).toHaveLength(1)
  })

  it('reuses the same Challenger for the next plan after a terminal one', async () => {
    const h = harness()
    await h.service.createPlan(rootAgent() as never, planInput())
    for (const id of ['t1', 't2', 't3']) {
      await h.service.challengerStartTask(challengerAgent(h) as never, id)
      await h.service.challengerReport(challengerAgent(h) as never, id, { summary: id, files: [], validation: 'ok' })
    }
    for (const id of ['t1', 't2', 't3']) await h.service.verifyTask(rootAgent() as never, id, 'succeeded')
    expect(h.service.getActivePlan('session-root')).toBeUndefined()
    const second = await h.service.createPlan(rootAgent() as never, planInput())
    expect(second.challengerSessionId).toBe(h.pair.challengerSessionId)
    // Exactly ONE plan-ready was delivered per plan: two plans, two briefs, and
    // the same persistent session id both times.
    const briefs = h.inbox.get(h.pair.challengerSessionId) ?? []
    expect(briefs).toHaveLength(2)
    // The provisioner ensure ran per plan, but the pair never changed.
    expect(h.ensureCalls).toEqual([{ sessionId: 'session-root' }, { sessionId: 'session-root' }])
    const plans = [...(h.service as unknown as { plans: Map<string, unknown> }).plans.values()]
    expect(plans).toHaveLength(1)
    expect((plans[0] as { planId: string }).planId).toBe(second.planId)
  })
})

describe('two-phase relays', () => {
  it('sends zero relays for intermediate reports and exactly one aggregate at the end', async () => {
    const h = harness()
    await h.service.createPlan(rootAgent() as never, planInput())
    const before = relays(h)
    for (const id of ['t1', 't2']) {
      const outcome = await h.service.challengerStartTask(challengerAgent(h) as never, id)
      void outcome
      const report = await h.service.challengerReport(challengerAgent(h) as never, id, { summary: id, files: [], validation: 'ok' })
      expect(report.phase).toBe('executing')
      expect(relays(h)).toBe(before)
    }
    await h.service.challengerStartTask(challengerAgent(h) as never, 't3')
    const final = await h.service.challengerReport(challengerAgent(h) as never, 't3', { summary: 't3', files: [], validation: 'ok' })
    expect(final.phase).toBe('review')
    expect(h.inbox.get(h.pair.endeavourSessionId)).toHaveLength(1)
    const aggregate = JSON.stringify(h.inbox.get(h.pair.endeavourSessionId)?.[0])
    expect(aggregate).toContain('t1')
    expect(aggregate).toContain('t3')
    expect(aggregate).toContain('endeavour_verify')
  })

  it('stops progression on a blocker and sends one early review request', async () => {
    const h = harness()
    await h.service.createPlan(rootAgent() as never, planInput())
    await h.service.challengerStartTask(challengerAgent(h) as never, 't1')
    const blocked = await h.service.challengerReport(challengerAgent(h) as never, 't1', {
      summary: 'no access', files: [], validation: 'n/a', blocker: 'permission denied',
    })
    expect(blocked.phase).toBe('blocked')
    expect(h.inbox.get(h.pair.endeavourSessionId)).toHaveLength(1)
    await expect(h.service.challengerStartTask(challengerAgent(h) as never, 't2')).rejects.toBeInstanceOf(EndeavourError)
  })

  it('verifies in order with zero reverse relays and finalizes only after the last verdict', async () => {
    const h = harness()
    await h.service.createPlan(rootAgent() as never, planInput())
    for (const id of ['t1', 't2', 't3']) {
      await h.service.challengerStartTask(challengerAgent(h) as never, id)
      await h.service.challengerReport(challengerAgent(h) as never, id, { summary: id, files: [], validation: 'ok' })
    }
    const relaysBefore = relays(h)
    await expect(h.service.verifyTask(rootAgent() as never, 't2', 'succeeded')).rejects.toBeInstanceOf(EndeavourError)
    const first = await h.service.verifyTask(rootAgent() as never, 't1', 'succeeded')
    expect(first.terminal).toBeUndefined()
    expect(relays(h)).toBe(relaysBefore)
    await h.service.verifyTask(rootAgent() as never, 't2', 'succeeded')
    const done = await h.service.verifyTask(rootAgent() as never, 't3', 'succeeded')
    expect(done.terminal?.outcome).toBe('completed')
    expect(relays(h)).toBe(relaysBefore)
  })
})

describe('authorization and recovery', () => {
  it('rejects spoofed Challenger or Endeavour callers', async () => {
    const h = harness()
    await h.service.createPlan(rootAgent() as never, planInput())
    const stranger = { session: { id: 'session-other' } }
    await expect(h.service.challengerStartTask(stranger as never, 't1')).rejects.toBeInstanceOf(EndeavourError)
    await expect(h.service.verifyTask(stranger as never, 't1', 'succeeded')).rejects.toBeInstanceOf(EndeavourError)
    const { peerPairIdFor: pairIdOf } = await import('../src/peer.js')
    const forged = { session: { id: challengerSessionIdFor('session-other') } }
    void pairIdOf
    await expect(h.service.challengerStartTask(forged as never, 't1')).rejects.toBeInstanceOf(EndeavourError)
  })

  it('reconciles a pending plan-ready after a transport failure and never resends a settled one', async () => {
    const h = harness()
    h.failResolve.add(h.pair.challengerSessionId)
    await h.service.createPlan(rootAgent() as never, planInput())
    // Delivery failed: the fact stays pending on the durable plan.
    expect(h.inbox.get(h.pair.challengerSessionId)).toHaveLength(0)
    const plan = h.service.getActivePlan('session-root')
    const pending = (plan?.deliveries ?? []).filter((fact) => fact.status === 'pending')
    expect(pending).toHaveLength(1)
    // The peer resumes; reconcile delivers exactly once and settles.
    h.failResolve.delete(h.pair.challengerSessionId)
    const delivered = await h.service.reconcileOutbox()
    expect(delivered).toBe(1)
    expect(h.inbox.get(h.pair.challengerSessionId)).toHaveLength(1)
    expect((h.service.getActivePlan('session-root')?.deliveries ?? []).every((fact) => fact.status === 'delivered')).toBe(true)
    expect(await h.service.reconcileOutbox()).toBe(0)
    expect(h.inbox.get(h.pair.challengerSessionId)).toHaveLength(1)
  })

  it('isolates two independent pairs', async () => {
    const a = harness('session-root-a')
    const b = harness('session-root-b')
    await a.service.createPlan(rootAgent('session-root-a') as never, planInput())
    await b.service.createPlan(rootAgent('session-root-b') as never, planInput())
    expect(a.pair.challengerSessionId).not.toBe(b.pair.challengerSessionId)
    // Each service only knows its own pair and plan.
    expect(a.service.getActivePlan('session-root-b')).toBeUndefined()
    await expect(a.service.challengerStartTask({ session: { id: b.pair.challengerSessionId } } as never, 't1'))
      .rejects.toBeInstanceOf(EndeavourError)
    expect(PeerError).toBeDefined()
    expect(PlanId).toBeDefined()
  })
})
