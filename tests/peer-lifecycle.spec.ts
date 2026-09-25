/**
 * Host lifecycle wiring: an eligible Endeavour session gets its persistent
 * Challenger as soon as it EXISTS (attached at mount, or announced through
 * `session/created`) — never by waiting for a plan, and never by prompting or
 * starting a model request. Standard, subagent and Challenger sessions are
 * ignored, so peer creation can never recurse.
 */

import { describe, expect, it, vi } from 'vitest'

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

import type { PeerState } from '../src/peer.js'
import type { PeerHostSeam } from '../src/peer-host.js'

const { EndeavourService } = await import('../src/service.js')
const { challengerSessionIdFor, peerEventPayload, peerPairIdFor } = await import('../src/peer.js')
const { PeerDeliveryLedger, PeerDeliveryQueue } = await import('../src/peer-transport.js')
const { PeerProvisioner } = await import('../src/peer-service.js')
const { createCordisPeerSeam } = await import('../src/peer-host.js')

interface FakeSession {
  id: string
  header: { agentPreset?: string; cwd?: string; origin?: string }
  seq: number
  events: { type: string; data: unknown }[]
  eventAt: (at: number) => unknown
  append: (type: string, data: unknown) => void
}

function fakeSession(id: string, header: FakeSession['header'], events: FakeSession['events'] = []): FakeSession {
  return {
    id,
    header,
    seq: events.length,
    events,
    eventAt: (at: number) => events[at],
    append: (type: string, data: unknown) => { events.push({ type, data }) },
  }
}

function pairOf(rootId: string): PeerState {
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

function lifecycleHarness(initial: FakeSession[]) {
  const sessions = new Map(initial.map((session) => [session.id, session]))
  const creates: { id: string; agentPreset?: string }[] = []
  const messages: unknown[] = []
  const listeners = new Map<string, ((payload: unknown) => void)[]>()
  const disposers: (() => void)[] = []
  const seam = {
    listSessionIds: () => [...sessions.keys()],
    sessionMeta: (id: string) => {
      const session = sessions.get(id)
      if (session === undefined) return undefined
      // Mirror production: the SELECTED preset event wins over the creation
      // header (the header records the base preset of a user preset).
      let preset = session.header.agentPreset
      for (let index = session.events.length - 1; index >= 0; index -= 1) {
        const event = session.events[index]
        if (event?.type !== 'agent-preset/selected') continue
        const value = (event.data as { readonly agentPreset?: unknown }).agentPreset
        preset = typeof value === 'string' && value !== '' ? value : preset
        break
      }
      return {
        id,
        ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
        ...(session.header.origin === undefined ? {} : { origin: session.header.origin as 'subagent' }),
        ...(preset === undefined ? {} : { agentPreset: preset }),
      }
    },
    createOrdinarySession: async (input: { id: string; agentPreset?: string }) => {
      creates.push({ id: input.id, ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }) })
      if (!sessions.has(input.id)) {
        sessions.set(input.id, fakeSession(input.id, {
          ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }),
          cwd: '/proj',
        }))
      }
      return { sessionId: input.id, adopted: true }
    },
    resolveAgent: async () => ({
      followup: (message: unknown) => { messages.push(message) },
      send: (message: unknown) => { messages.push(message) },
    }),
    workspaceIdFor: () => 'ws-1',
    attachToWorkspace: async (id: string) => { attaches.push(id) },
    ensurePermissionPreset: async (id: string, preset: string) => { permissions.push({ id, preset }) },
    ensurePairTitles: async (pair: { pairId: string }) => { titles.push(pair.pairId) },
    selectionOf: () => undefined,
    selectModel: async () => undefined,
    copyModelSelection: async (from: string, to: string) => {
      // Double-step mirror of production: never overwrite an existing selection.
      copies.push({ from, to })
    },
  }
  const attaches: string[] = []
  const permissions: { id: string; preset: string }[] = []
  const titles: string[] = []
  const copies: { from: string; to: string }[] = []
  const pairs = new Map<string, PeerState>()
  /** Durable read emulation: the latest checkpoint recorded in the log itself. */
  const durablePair = (sessionId: string): PeerState | undefined => {
    const events = sessions.get(sessionId)?.events ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'endeavour/peer') continue
      const state = (event.data as { readonly plan?: PeerState }).plan
      if (state !== undefined) return state
    }
    return undefined
  }
  const provisioner = new PeerProvisioner({
    seam,
    readPair: (sessionId) => pairs.get(sessionId) ?? durablePair(sessionId),
    hasCheckpoint: (sessionId) => (sessions.get(sessionId)?.events ?? []).some((event) => event.type === 'endeavour/peer'),
    appendPair: async (rootSessionId, state) => {
      const payload = peerEventPayload('peer-created', undefined, state, 1)
      for (const id of [rootSessionId, state.challengerSessionId]) sessions.get(id)?.append('endeavour/peer', payload)
      pairs.set(rootSessionId, state)
      pairs.set(state.challengerSessionId, state)
    },
    now: () => 1,
  })
  const ctx = {
    reflect: { provide: () => () => undefined },
    sessions: { get: (id: string) => sessions.get(id), list: () => [...sessions.values()], flush: async () => true },
    sessionProjections: { register: () => () => undefined },
    on: (name: string, listener: (payload: unknown) => void) => {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      const off = () => { listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener)) }
      return off
    },
    effect: (callback: () => () => void) => { disposers.push(callback()) },
  }
  const service = new EndeavourService(ctx as never, {})
  service.setPeerRuntime({ seam, provisioner, queue: new PeerDeliveryQueue(), ledger: new PeerDeliveryLedger() })
  /** Announce a session exactly like the host does: live in the store first. */
  const announce = (id: string, header: FakeSession['header'] = { agentPreset: 'endeavour', cwd: '/proj' }): void => {
    if (!sessions.has(id)) sessions.set(id, fakeSession(id, header))
    for (const listener of listeners.get('session/created') ?? []) listener(sessions.get(id))
  }
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) (listener as (...a: unknown[]) => void)(...args)
  }
  return { service, sessions, creates, messages, attaches, permissions, titles, copies, announce, emit, disposers }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

describe('session metadata resolution', () => {
  /** Real sessions record the CREATION preset in the header and the SELECTED
   *  preset as an `agent-preset/selected` event; the event must win. */
  function seamMeta(events: { type: string; data: unknown }[], headerPreset?: string) {
    const session = {
      id: 'session-x',
      header: { cwd: '/proj', ...(headerPreset === undefined ? {} : { agentPreset: headerPreset }) },
      seq: events.length,
      eventAt: (at: number) => events[at],
    }
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') return { get: (id: string) => (id === 'session-x' ? session : undefined), list: () => [session] }
        if (name === 'sessionController') return { create: async () => ({}), resolveAgent: async () => ({}) }
        return undefined
      },
    }
    return createCordisPeerSeam(ctx).sessionMeta('session-x')
  }

  it('prefers the selected preset event over the creation header', () => {
    expect(seamMeta([{ type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } }], 'standard')?.agentPreset).toBe('endeavour')
  })

  it('uses the LAST selection, so switching away from Endeavour is respected', () => {
    expect(seamMeta([
      { type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } },
      { type: 'agent-preset/selected', data: { agentPreset: 'standard' } },
    ], 'standard')?.agentPreset).toBe('standard')
  })

  it('falls back to the header when no selection event exists', () => {
    expect(seamMeta([], 'endeavour')?.agentPreset).toBe('endeavour')
  })

  /** Durable selection read: the same events the official projection folds. */
  function seamSelection(events: { type: string; data: unknown }[]) {
    const session = { id: 'session-x', header: { agentPreset: 'endeavour', cwd: '/proj' }, seq: events.length, eventAt: (at: number) => events[at] }
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') return { get: (id: string) => (id === 'session-x' ? session : undefined), list: () => [session] }
        if (name === 'sessionController') return { create: async () => ({}), resolveAgent: async () => ({}) }
        return undefined
      },
    }
    return createCordisPeerSeam(ctx).selectionOf?.('session-x')
  }

  it('reads the latest selection event, then the request header', () => {
    const header = { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } } } }
    const selection = { type: 'model/selection', data: { provider: 'p2', model: 'm2', reasoningEffort: 'low' } }
    expect(seamSelection([header])).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
    expect(seamSelection([header, selection])).toEqual({ provider: 'p2', model: 'm2', reasoningEffort: 'low' })
  })

  it('drops an adapter-defaulted effort and reports nothing when unselected', () => {
    const defaulted = { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } } }
    expect(seamSelection([defaulted])).toEqual({ provider: 'p1', model: 'm1' })
    expect(seamSelection([])).toBeUndefined()
  })
})

describe('peer session lifecycle', () => {
  it('creates exactly one peer when an Endeavour session is announced, without a plan, prompt or model call', async () => {
    const h = lifecycleHarness([])
    h.service.observeSessionLifecycle()
    expect(h.creates).toHaveLength(0)
    h.announce('session-root')
    await settle()
    expect(h.creates).toEqual([{ id: challengerSessionIdFor('session-root'), agentPreset: 'challenger' }])
    expect(h.messages).toEqual([])
  })

  it('observes sessions already attached at mount and disposes its subscription', async () => {
    const h = lifecycleHarness([fakeSession('session-root', { agentPreset: 'endeavour', cwd: '/proj' })])
    const dispose = h.service.observeSessionLifecycle()
    await settle()
    expect(h.creates).toHaveLength(1)
    dispose()
    h.announce('session-later')
    await settle()
    expect(h.creates).toHaveLength(1)
  })

  it('ignores Standard chats, subagent sessions and the Challenger announcement itself', async () => {
    const h = lifecycleHarness([
      fakeSession('session-standard', { agentPreset: 'standard' }),
      fakeSession('session-child', { agentPreset: 'endeavour', origin: 'subagent' }),
      fakeSession('session-root', { agentPreset: 'endeavour', cwd: '/proj' }),
    ])
    h.service.observeSessionLifecycle()
    await settle()
    // The challenger created by the root announcement triggers another
    // `session/created` from the host; observing it must not recurse.
    const created = h.creates[0]
    expect(created).toEqual({ id: challengerSessionIdFor('session-root'), agentPreset: 'challenger' })
    h.announce(created?.id ?? '', { agentPreset: 'challenger' })
    await settle()
    expect(h.creates).toHaveLength(1)
    expect(h.creates.some((call) => call.id === 'session-standard' || call.id === 'session-child')).toBe(false)
  })

  it('guarantees Full access on the Challenger only and applies both titles', async () => {
    const pair = pairOf('session-root')
    const payload = peerEventPayload('peer-created', undefined, pair, 1)
    const root = fakeSession('session-root', { agentPreset: 'standard', cwd: '/proj' }, [
      { type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } },
      { type: 'endeavour/peer', data: payload },
    ])
    const peer = fakeSession(pair.challengerSessionId, { agentPreset: 'challenger', cwd: '/proj' }, [
      { type: 'endeavour/peer', data: payload },
    ])
    const h = lifecycleHarness([root, peer])
    h.service.observeSessionLifecycle()
    await settle()
    // Exactly one Full-access guarantee, for the CHALLENGER, and both titles.
    expect(h.permissions).toEqual([{ id: pair.challengerSessionId, preset: 'danger-full-access' }])
    expect(h.titles).toEqual([pair.pairId])
    // The Endeavour side is never given a different permission preset.
    expect(h.permissions.some((call) => call.id === 'session-root')).toBe(false)
    // A repeated observation (restart) re-runs the idempotent repairs once.
    h.announce('session-root')
    await settle()
    expect(h.permissions).toHaveLength(1)
  })

  it('repairs an existing pair exactly once after an upgrade, with no new session', async () => {
    const pair = pairOf('session-root')
    const payload = peerEventPayload('peer-created', undefined, pair, 1)
    const root = fakeSession('session-root', { agentPreset: 'standard', cwd: '/proj' }, [
      { type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } },
      { type: 'endeavour/peer', data: payload },
    ])
    const peer = fakeSession(pair.challengerSessionId, { agentPreset: 'challenger', cwd: '/proj' }, [
      { type: 'endeavour/peer', data: payload },
    ])
    const h = lifecycleHarness([root, peer])
    h.service.observeSessionLifecycle()
    await settle()
    // Workspace membership and the one-time route initialization ran once...
    expect(h.attaches).toEqual([pair.challengerSessionId])
    expect(h.copies).toEqual([{ from: 'session-root', to: pair.challengerSessionId }])
    // ...no session was created and the checkpoint was not duplicated.
    expect(h.creates).toEqual([])
    expect(root.events.filter((event) => event.type === 'endeavour/peer')).toHaveLength(1)
    expect(peer.events.filter((event) => event.type === 'endeavour/peer')).toHaveLength(1)
    // A second announcement is deduplicated by the observation ledger.
    h.announce('session-root')
    await settle()
    expect(h.copies).toHaveLength(1)
    expect(h.creates).toEqual([])
  })

  it('observes a session that was Standard when created and became Endeavour later', async () => {
    // The exact live race: the session is created (and announced) as Standard,
    // so the creation observation must NOT mark it seen; the later official
    // preset selection is what makes it eligible.
    const session = fakeSession('session-late', { agentPreset: 'standard', cwd: '/proj' })
    const h = lifecycleHarness([session])
    h.service.observeSessionLifecycle()
    h.announce('session-late')
    await settle()
    expect(h.creates).toEqual([])
    // The user (or the app) selects the Endeavour preset: the host emits the
    // official event with (sessionId, preset) and the durable event lands.
    session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'endeavour' } })
    session.seq = session.events.length
    h.emit('agent-preset/selected', 'session-late', 'endeavour')
    await settle()
    expect(h.creates).toEqual([{ id: challengerSessionIdFor('session-late'), agentPreset: 'challenger' }])
    // Repeated selections and a re-mount never duplicate the peer.
    h.emit('agent-preset/selected', 'session-late', 'endeavour')
    h.service.observeSessionLifecycle()
    await settle()
    expect(h.creates).toHaveLength(1)
  })

  it('ignores challenger and standard preset selections', async () => {
    const standard = fakeSession('session-standard', { agentPreset: 'standard', cwd: '/proj' })
    const challenger = fakeSession('session-challenger', { agentPreset: 'challenger', cwd: '/proj' })
    const h = lifecycleHarness([standard, challenger])
    h.service.observeSessionLifecycle()
    h.emit('agent-preset/selected', 'session-standard', 'standard')
    h.emit('agent-preset/selected', 'session-challenger', 'challenger')
    await settle()
    expect(h.creates).toEqual([])
  })

  it('adopts a cold (not-live) Challenger without growing the checkpoint log', async () => {
    const pair = pairOf('session-root')
    const payload = peerEventPayload('peer-created', undefined, pair, 1)
    // Only the ROOT is live: the Challenger exists on disk but is not attached,
    // which is the normal state in a fresh process.
    const root = fakeSession('session-root', { agentPreset: 'endeavour', cwd: '/proj' }, [{ type: 'endeavour/peer', data: payload }])
    const h = lifecycleHarness([root])
    h.service.observeSessionLifecycle()
    await settle()
    // The pair is adopted (one create call that adopts the existing id)...
    expect(h.creates).toHaveLength(1)
    expect(h.creates[0]?.id).toBe(pair.challengerSessionId)
    // ...and NOTHING is appended: the root checkpoint count is unchanged.
    expect(root.events.filter((event) => event.type === 'endeavour/peer')).toHaveLength(1)
    expect(h.attaches).toEqual([pair.challengerSessionId])
    expect(h.copies).toEqual([{ from: 'session-root', to: pair.challengerSessionId }])
  })

  it('adopts an existing durable pair on restart without creating a duplicate session', async () => {
    const pair = pairOf('session-root')
    const payload = peerEventPayload('peer-created', undefined, pair, 1)
    const h = lifecycleHarness([
      fakeSession('session-root', { agentPreset: 'endeavour', cwd: '/proj' }, [{ type: 'endeavour/peer', data: payload }]),
      fakeSession(pair.challengerSessionId, { agentPreset: 'challenger', cwd: '/proj' }, [{ type: 'endeavour/peer', data: payload }]),
    ])
    h.service.observeSessionLifecycle()
    h.announce('session-root')
    await settle()
    expect(h.creates).toHaveLength(0)
    expect(h.messages).toEqual([])
  })
})

describe('reselected Challenger rows', () => {
  it('heals a Challenger that was switched to Endeavour instead of making it a new root', async () => {
    const pair = pairOf('session-root')
    const repairs: { id: string; preset: string }[] = []
    const created: string[] = []
    const seam: PeerHostSeam = {
      listSessionIds: () => [pair.challengerSessionId],
      sessionMeta: () => ({
        id: pair.challengerSessionId,
        headerAgentPreset: 'challenger',
        selectedAgentPreset: 'endeavour',
      }),
      createOrdinarySession: async (input) => {
        created.push(input.id)
        return { sessionId: input.id, adopted: false }
      },
      resolveAgent: async () => undefined,
      repairPreset: async (sessionId, preset) => {
        repairs.push({ id: sessionId, preset })
      },
    }
    const provisioner = new PeerProvisioner({
      seam,
      readPair: () => pair,
      hasCheckpoint: () => true,
      appendPair: async () => undefined,
      now: () => 1,
    })

    await expect(provisioner.ensure(pair.challengerSessionId)).rejects.toThrow('is a Challenger session')
    expect(created).toEqual([])
    expect(repairs).toEqual([{ id: pair.challengerSessionId, preset: 'challenger' }])
  })
})
