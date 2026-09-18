/**
 * Ordinary companion provisioning + typed peer transport regressions:
 * deterministic idempotent creation, crash repair, fail-closed conflicts,
 * authorization, FIFO delivery, dedupe and lifecycle ignore rules.
 * Every dependency is a fake; no session, prompt or model request exists here.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { challengerSessionIdFor, PeerError, peerPairIdFor, type PeerState } from '../src/peer.js'
import type { PeerAgentFace, PeerHostSeam, PeerSessionMeta } from '../src/peer-host.js'
import { PeerLifecycle, PeerProvisioner } from '../src/peer-service.js'
import {
  authorizePeerRelay,
  deliverPeerRelay,
  PeerDeliveryLedger,
  PeerDeliveryQueue,
  peerDedupeKey,
  peerRelayText,
  type PeerRelay,
} from '../src/peer-transport.js'

interface FakeSession extends PeerSessionMeta { cwd?: string }

function fakeSeam(seed: FakeSession[]): {
  seam: PeerHostSeam
  sessions: Map<string, FakeSession>
  creates: { id: string; agentPreset: string; cwd?: string }[]
  agents: Map<string, PeerAgentFace & { inbox: unknown[]; wakeups: number }>
} {
  const sessions = new Map(seed.map((session) => [session.id, session]))
  const creates: { id: string; agentPreset: string; cwd?: string }[] = []
  const agents = new Map<string, PeerAgentFace & { inbox: unknown[]; wakeups: number }>()
  const seam: PeerHostSeam = {
    listSessionIds: () => [...sessions.keys()],
    sessionMeta: (id) => sessions.get(id),
    createOrdinarySession: (input) => {
      creates.push({ id: input.id, agentPreset: input.agentPreset, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) })
      sessions.set(input.id, { id: input.id, agentPreset: input.agentPreset, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) })
    },
    resolveAgent: (id) => agents.get(id),
    workspaceOf: () => undefined,
  }
  return { seam, sessions, creates, agents }
}

function provisioner(seam: PeerHostSeam, state: { pair?: PeerState; appends: { kind: string; state: PeerState }[] }): PeerProvisioner {
  return new PeerProvisioner({
    seam,
    readPair: () => state.pair,
    appendPair: async (_root, next, kind) => {
      state.pair = next
      state.appends.push({ kind, state: next })
    },
    now: () => 1_000,
  })
}

describe('provisioning', () => {
  it('creates one deterministic ordinary challenger per root and reuses it', async () => {
    const { seam, creates } = fakeSeam([
      { id: 'session-a', agentPreset: 'endeavour', cwd: '/work' },
      { id: 'session-b', agentPreset: 'endeavour', cwd: '/work' },
    ])
    const stateA: { pair?: PeerState; appends: { kind: string; state: PeerState }[] } = { appends: [] }
    const stateB: { pair?: PeerState; appends: { kind: string; state: PeerState }[] } = { appends: [] }
    const a = provisioner(seam, stateA)
    const b = provisioner(seam, stateB)
    const first = await a.ensure('session-a')
    const again = await a.ensure('session-a')
    const other = await b.ensure('session-b')
    expect(first.challengerSessionId).toBe(challengerSessionIdFor('session-a'))
    expect(again.challengerSessionId).toBe(first.challengerSessionId)
    expect(other.challengerSessionId).not.toBe(first.challengerSessionId)
    expect(creates).toEqual([
      { id: first.challengerSessionId, agentPreset: 'challenger', cwd: '/work' },
      { id: other.challengerSessionId, agentPreset: 'challenger', cwd: '/work' },
    ])
    // Idempotent retry appended nothing new.
    expect(stateA.appends).toHaveLength(1)
    expect(stateA.appends[0]?.kind).toBe('peer-created')
  })

  it('serializes concurrent ensures to exactly one create and one checkpoint', async () => {
    const { seam, creates } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }])
    const state: { pair?: PeerState; appends: { kind: string; state: PeerState }[] } = { appends: [] }
    const service = provisioner(seam, state)
    const results = await Promise.all([service.ensure('session-a'), service.ensure('session-a'), service.ensure('session-a')])
    expect(new Set(results.map((pair) => pair.challengerSessionId)).size).toBe(1)
    expect(creates).toHaveLength(1)
    expect(state.appends).toHaveLength(1)
  })

  it('repairs a durable mapping whose challenger session vanished', async () => {
    const { seam, creates } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }])
    const existing = {
      version: 1 as const,
      pairId: 'pair-x',
      endeavourSessionId: 'session-a',
      challengerSessionId: challengerSessionIdFor('session-a'),
      createdAt: 1,
      updatedAt: 1,
      sequence: 1,
    }
    // The pair id must be the deterministic one for validation to pass.
    const { peerPairIdFor } = await import('../src/peer.js')
    const state: { pair?: PeerState; appends: { kind: string; state: PeerState }[] } = {
      pair: { ...existing, pairId: peerPairIdFor('session-a') },
      appends: [],
    }
    const service = provisioner(seam, state)
    const repaired = await service.ensure('session-a')
    expect(creates).toHaveLength(1)
    expect(state.appends.at(-1)?.kind).toBe('peer-updated')
    expect(repaired.sequence).toBe(2)
  })

  it('fails closed for Standard, Challenger, subagent and conflicting sessions', async () => {
    const { seam } = fakeSeam([
      { id: 'session-std', agentPreset: 'standard' },
      { id: 'session-chal', agentPreset: 'challenger' },
      { id: 'session-sub', agentPreset: 'endeavour', origin: 'subagent' },
    ])
    const service = provisioner(seam, { appends: [] })
    await expect(service.ensure('session-missing')).rejects.toMatchObject({ code: 'peer-unknown-session' })
    await expect(service.ensure('session-std')).rejects.toMatchObject({ code: 'peer-not-endeavour' })
    await expect(service.ensure('session-chal')).rejects.toMatchObject({ code: 'peer-not-endeavour' })
    await expect(service.ensure('session-sub')).rejects.toMatchObject({ code: 'peer-not-ordinary' })

    const conflict = fakeSeam([
      { id: 'session-a', agentPreset: 'endeavour' },
      { id: challengerSessionIdFor('session-a'), agentPreset: 'standard' },
    ])
    await expect(provisioner(conflict.seam, { appends: [] }).ensure('session-a'))
      .rejects.toMatchObject({ code: 'peer-conflict' })
    expect(conflict.creates).toHaveLength(0)
  })

  it('never prompts, starts a subagent, or exposes a general send tool', () => {
    const host = readFileSync('src/peer-host.ts', 'utf8')
    const service = readFileSync('src/peer-service.ts', 'utf8')
    const transport = readFileSync('src/peer-transport.ts', 'utf8')
    for (const source of [host, service, transport]) {
      expect(source).not.toMatch(/startContinuable|openSubagent|SubagentAddress|subagents\.|send_message/)
    }
    expect(service).not.toMatch(/prompt:/)
  })

  it('observes only unpaired sessions and never recurses on the created challenger', async () => {
    const { seam, creates } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }])
    const state: { pair?: PeerState; appends: { kind: string; state: PeerState }[] } = { appends: [] }
    const service = provisioner(seam, state)
    const observed: string[] = []
    const lifecycle = new PeerLifecycle(service, {
      readPair: (id) => (state.pair?.endeavourSessionId === id ? state.pair : undefined),
      onError: (error) => { observed.push(String((error as Error).message)) },
    })
    lifecycle.observe('session-a')
    lifecycle.observe('session-a')
    await Promise.resolve()
    await Promise.resolve()
    expect(creates).toHaveLength(1)
    // Observing the challenger (as the host would after creation) is ignored.
    lifecycle.observe(state.pair?.challengerSessionId ?? '')
    await Promise.resolve()
    expect(creates).toHaveLength(1)
    expect(observed).toEqual([])
  })
})

describe('transport', () => {
  const challenger = challengerSessionIdFor('session-a')
  const pair: PeerState = {
    version: 1,
    pairId: peerPairIdFor('session-a'),
    endeavourSessionId: 'session-a',
    challengerSessionId: challenger,
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
  const relay = (overrides: Partial<PeerRelay> = {}): PeerRelay => ({
    pairId: pair.pairId,
    planId: 'plan-1',
    messageKind: 'plan-ready',
    senderRole: 'endeavour',
    senderSessionId: 'session-a',
    targetSessionId: challenger,
    body: 'Execute the whole plan.',
    ...overrides,
  })

  it('authorizes only the exact reciprocal pair member and protocol step', () => {
    expect(authorizePeerRelay(pair, relay())).toEqual([])
    expect(authorizePeerRelay(pair, relay({ messageKind: 'review-ready' }))).toEqual([])
    expect(authorizePeerRelay(undefined, relay())).toContain('sender is not part of a pair')
    expect(authorizePeerRelay(pair, relay({ pairId: 'other' }))).toContain('relay pairId does not match the durable pair')
    expect(authorizePeerRelay(pair, relay({ planId: ' ' }))).toContain('relay planId must not be empty')
    expect(authorizePeerRelay(pair, relay({ senderSessionId: 'session-other' }))).toContain('sender does not belong to the pair')
    expect(authorizePeerRelay(pair, relay({ senderRole: 'challenger' }))).toContain('sender role challenger does not match its session')
    expect(authorizePeerRelay(pair, relay({ targetSessionId: 'session-a' }))).toContain('target is not the exact counterpart of the pair')
    expect(authorizePeerRelay(pair, relay({ targetSessionId: 'session-a', senderRole: 'challenger', senderSessionId: challenger })))
      .toContain('only the Endeavour side may send plan-ready')
    expect(authorizePeerRelay(pair, relay({ targetSessionId: 'session-other' }))).toContain('target is not the exact counterpart of the pair')
  })

  it('attributes the relay explicitly and dedupes retries', async () => {
    const { seam, agents } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }, { id: challenger, agentPreset: 'challenger' }])
    const inbox: unknown[] = []
    agents.set(challenger, { inbox, wakeups: 0, followup: (message) => { inbox.push(message); agents.get('session-b')!.wakeups += 1 }, send: () => undefined })
    const deps = { seam, readPair: () => pair }
    const queue = new PeerDeliveryQueue()
    const ledger = new PeerDeliveryLedger()
    const first = await deliverPeerRelay(deps, queue, ledger, relay())
    const retry = await deliverPeerRelay(deps, queue, ledger, relay())
    expect(first.delivered).toBe(true)
    expect(retry).toEqual({ delivered: false, dedupeKey: peerDedupeKey(relay()) })
    expect(inbox).toHaveLength(1)
    const text = peerRelayText(relay())
    expect(text).toContain('Endeavour → Challenger')
    expect(text).toContain('plan-ready')
    expect(text).toContain('plan-1')
    expect(peerDedupeKey(relay({ messageKind: 'review-ready' }))).not.toBe(peerDedupeKey(relay()))
  })

  it('delivers FIFO per pair and falls back to a next-turn wakeup when busy', async () => {
    const textOf = (message: unknown): string =>
      ((message as { content?: readonly { text?: string }[] }).content ?? []).map((block) => block.text ?? '').join(' ')
    const { seam, agents } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }, { id: challenger, agentPreset: 'challenger' }])
    const order: string[] = []
    const sends: string[] = []
    agents.set(challenger, {
      inbox: [],
      wakeups: 0,
      followup: (message) => { order.push(textOf(message)); throw new Error('busy') },
      send: (message) => { sends.push(textOf(message)) },
    })
    const deps = { seam, readPair: () => pair }
    const queue = new PeerDeliveryQueue()
    const ledger = new PeerDeliveryLedger()
    await Promise.all([
      deliverPeerRelay(deps, queue, ledger, relay({ planId: 'p1' })),
      deliverPeerRelay(deps, queue, ledger, relay({ planId: 'p2' })),
    ])
    expect(order).toHaveLength(2)
    expect(sends).toHaveLength(2)
    expect(sends[0]).toContain('p1')
    expect(sends[1]).toContain('p2')
  })

  it('rejects unauthorized relays before any wakeup and reports offline targets', async () => {
    const { seam, agents } = fakeSeam([{ id: 'session-a', agentPreset: 'endeavour' }, { id: challenger, agentPreset: 'challenger' }])
    const deps = { seam, readPair: () => pair }
    const queue = new PeerDeliveryQueue()
    const ledger = new PeerDeliveryLedger()
    await expect(deliverPeerRelay(deps, queue, ledger, relay({ pairId: 'other' }))).rejects.toBeInstanceOf(PeerError)
    await expect(deliverPeerRelay(deps, queue, ledger, relay())).rejects.toMatchObject({ code: 'peer-target-offline' })
    agents.set(challenger, { inbox: [], wakeups: 0, followup: () => undefined, send: () => undefined })
    await expect(deliverPeerRelay(deps, queue, ledger, relay({ senderSessionId: challenger, senderRole: 'challenger', targetSessionId: 'session-a' })))
      .rejects.toMatchObject({ code: 'peer-unauthorized' })
  })
})
