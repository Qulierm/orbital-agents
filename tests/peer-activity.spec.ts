/**
 * Peer activity and repair regressions.
 *
 * 1. The durable `endeavour/peer` checkpoint must classify a turn-less pair
 *    member as Conversation activity (registered view definition), so both
 *    halves render the native header/strip without a synthetic turn.
 * 2. A blank deterministic Challenger whose immutable header says `challenger`
 *    but whose latest selection diverged is repaired through the official
 *    preset service; a STARTED mismatch is never rewritten.
 * 3. Extension CSS never clips the native input-left parent (RiskConfirmation).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  endeavourPeerNodeDefinition,
  endeavourPeerViewDefinition,
  PEER_ACTIVITY_TARGET,
} from '../src/client/peer-activity.js'
import { peerEventPayload, peerPairIdFor, challengerSessionIdFor } from '../src/peer.js'
import { STYLE_TEXT } from '../src/client/styles.js'
import { reconcilePeerActivity } from '../src/client/peer-tab.js'

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

const { PeerProvisioner } = await import('../src/peer-service.js')
const { PeerDeliveryLedger, PeerDeliveryQueue } = await import('../src/peer-transport.js')
const { EndeavourService } = await import('../src/service.js')

function pair(rootId = 'session-root') {
  return {
    version: 1 as const,
    pairId: peerPairIdFor(rootId),
    endeavourSessionId: rootId,
    challengerSessionId: challengerSessionIdFor(rootId),
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

describe('peer activity definitions', () => {
  const state = pair()
  const payload = peerEventPayload('peer-created', undefined, state, 1)
  const event = { type: 'endeavour/peer', data: payload, seq: 3, time: 1 }

  it('folds the durable checkpoint into an activity node for the peer target', () => {
    const match = endeavourPeerNodeDefinition.match(event as never)
    expect(match).toEqual({ id: state.pairId, role: 'start' })
    const context = {
      key: 'k',
      id: state.pairId,
      start: { event: { seq: 3 }, location: {} },
      state,
    }
    const node = endeavourPeerNodeDefinition.buildViewNode?.(context as never)
    expect(node?.target).toBe(PEER_ACTIVITY_TARGET)
    expect(node?.data).toEqual({ paired: true })
    // Unrelated events never match.
    expect(endeavourPeerNodeDefinition.match({ type: 'turn/start', data: {}, seq: 1, time: 1 } as never)).toBeNull()
  })

  it('classifies the target as active only while a checkpoint node exists', () => {
    const builder = endeavourPeerViewDefinition.create()
    expect(endeavourPeerViewDefinition.target).toBe(PEER_ACTIVITY_TARGET)
    expect(endeavourPeerViewDefinition.isActive?.(builder.empty)).toBe(false)
    const node = { key: 'k' } as never
    expect(endeavourPeerViewDefinition.isActive?.(builder.replace({ nodes: [node], timeline: {} } as never))).toBe(true)
  })

  it('activates the target exactly once per paired session', () => {
    const a = pair()
    let current = 'session-root'
    const listeners = new Set<() => void>()
    const face = { getSnapshot: () => a, subscribe: () => () => undefined }
    const activated: string[] = []
    const dispose = reconcilePeerActivity({
      currentSession: () => current,
      subscribeCurrent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      peerFace: (sessionId, key) => (key === 'endeavourPeer' ? face : undefined),
      activate: (sessionId) => { activated.push(sessionId) },
    })
    expect(activated).toEqual(['session-root'])
    for (const listener of [...listeners]) listener()
    expect(activated).toEqual(['session-root'])
    // The CHALLENGER side activates its own target as well.
    current = a.challengerSessionId
    for (const listener of [...listeners]) listener()
    expect(activated).toEqual(['session-root', a.challengerSessionId])
    dispose()
  })
})

describe('blank Challenger preset repair', () => {
  function harness(options: { selected: string; hasTurnStart: boolean }) {
    const state = pair('session-root')
    const payload = peerEventPayload('peer-created', undefined, state, 1)
    const challengerEvents: { type: string; data: unknown }[] = [
      { type: 'endeavour/peer', data: payload },
      { type: 'agent-preset/selected', data: { agentPreset: options.selected } },
    ]
    if (options.hasTurnStart) challengerEvents.push({ type: 'turn/start', data: {} })
    const challenger = {
      id: state.challengerSessionId,
      header: { agentPreset: 'challenger', cwd: '/proj' },
      seq: challengerEvents.length,
      events: challengerEvents,
      eventAt: (at: number) => challengerEvents[at],
      append: (type: string, data: unknown) => { challengerEvents.push({ type, data }) },
    }
    const rootEvents: { type: string; data: unknown }[] = [
      // The live root records its preset as a selection event (the header keeps
      // the creation base), which is what makes it an eligible Endeavour session.
      { type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } },
      { type: 'endeavour/peer', data: payload },
    ]
    const root = {
      id: 'session-root',
      header: { agentPreset: 'standard', cwd: '/proj' },
      seq: rootEvents.length,
      events: rootEvents,
      eventAt: (at: number) => rootEvents[at],
      append: (type: string, data: unknown) => { rootEvents.push({ type, data }) },
    }
    const sessions = new Map([[root.id, root], [challenger.id, challenger]])
    const repairs: { sessionId: string; preset: string }[] = []
    const diagnostics: string[] = []
    const seam = {
      listSessionIds: () => [...sessions.keys()],
      sessionMeta: (id: string) => {
        const session = sessions.get(id)
        if (session === undefined) return undefined
        const selected = [...session.events].reverse().find((event) => event.type === 'agent-preset/selected')?.data as { agentPreset?: string } | undefined
        return {
          id,
          cwd: '/proj',
          agentPreset: selected?.agentPreset ?? session.header.agentPreset,
          headerAgentPreset: session.header.agentPreset,
          ...(selected?.agentPreset === undefined ? {} : { selectedAgentPreset: selected.agentPreset }),
          ...(session.events.some((event) => event.type === 'turn/start') ? { hasTurnStart: true } : {}),
        }
      },
      createOrdinarySession: async (input: { id: string }) => ({ sessionId: input.id, adopted: true }),
      resolveAgent: async () => undefined,
      attachToWorkspace: async () => undefined,
      copyModelSelection: async () => undefined,
      repairPreset: async (sessionId: string, preset: string) => { repairs.push({ sessionId, preset }) },
    }
    const provisioner = new PeerProvisioner({
      seam,
      readPair: (sessionId) => (sessionId === root.id || sessionId === challenger.id ? state : undefined),
      hasCheckpoint: (sessionId) => sessions.get(sessionId)?.events.some((event) => event.type === 'endeavour/peer') === true,
      appendPair: async () => undefined,
      now: () => 1,
      diagnose: (message) => { diagnostics.push(message) },
    })
    const ctx = {
      reflect: { provide: () => () => undefined },
      sessions: { get: (id: string) => sessions.get(id), list: () => [...sessions.values()], flush: async () => true },
      sessionProjections: { register: () => () => undefined },
    }
    const service = new EndeavourService(ctx as never, {})
    service.setPeerRuntime({ seam, provisioner, queue: new PeerDeliveryQueue(), ledger: new PeerDeliveryLedger() })
    return { service, repairs, diagnostics, challenger }
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  it('recomposes a blank diverged pair member back to challenger', async () => {
    const h = harness({ selected: 'endeavour', hasTurnStart: false })
    h.service.observeSessionLifecycle()
    await settle()
    expect(h.repairs).toEqual([{ sessionId: h.challenger.id, preset: 'challenger' }])
    expect(h.diagnostics.some((line) => line.includes('repaired'))).toBe(true)
  })

  it('fails closed on a STARTED mismatch without rewriting', async () => {
    const h = harness({ selected: 'endeavour', hasTurnStart: true })
    h.service.observeSessionLifecycle()
    await settle()
    expect(h.repairs).toEqual([])
    expect(h.diagnostics.some((line) => line.includes('STARTED'))).toBe(true)
  })

  it('never touches a correctly composed member', async () => {
    const h = harness({ selected: 'challenger', hasTurnStart: false })
    h.service.observeSessionLifecycle()
    await settle()
    expect(h.repairs).toEqual([])
    expect(h.diagnostics).toEqual([])
  })
})

describe('extension CSS and native permission compatibility', () => {
  it('never clips the native input-left parent (RiskConfirmation lives there)', () => {
    // Split into rules and assert NO rule whose selector targets the input-left
    // parent sets overflow/clip: that silently swallowed the Full access modal.
    const rules = STYLE_TEXT.split('}').map((chunk) => chunk.trim()).filter(Boolean)
    for (const rule of rules) {
      const [selector = '', body = ''] = rule.split('{')
      if (!selector.includes('conversation.input.left')) continue
      const targetsParent = selector.includes(':has(> [data-slot="conversation.input.left"])')
        && !/\[data-slot="conversation\.input\.left"\]\s*>/.test(selector)
      if (!targetsParent) continue
      expect(body).not.toMatch(/overflow\s*:/)
    }
    expect(STYLE_TEXT).not.toContain(':has(> [data-slot="conversation.input.left"]) > div {')
  })
})
