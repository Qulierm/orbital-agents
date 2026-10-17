/**
 * Model bridge acquisition contract.
 *
 * The unified menu configures TWO ordinary sessions. The Endeavour side IS the
 * session the control renders in, so its directory is borrowed from the main
 * view. The paired Challenger can be alive and validated while its CLIENT
 * directory still does not resolve, because that directory needs a retained
 * scope/binding — so the bridge offers an owned reference for exactly that peer,
 * under a source this owner can release again.
 *
 * These tests pin the bridge half: which id is retained, when nothing is
 * retained, and that acquisition stays out of render-time paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { challengerSessionIdFor, peerPairIdFor, PEER_STATE_VERSION, type PeerState } from '../src/peer.js'
import { CHALLENGER_MODEL_SEAT, MODEL_MENU_RETENTION_SOURCE } from '../src/client/index.js'
import type { UnifiedModelController } from '../src/client/UnifiedModelControl.js'
import { challengerSelectionStorageKey } from '../src/client/challenger-selection-store.js'

const ROOT = 'session-root'
const CHALLENGER = challengerSessionIdFor(ROOT)
const OTHER_ROOT = 'session-other'
const OTHER_CHALLENGER = challengerSessionIdFor(OTHER_ROOT)

/** A fully valid pair state for the Endeavour side of `ROOT`. */
function peerState(endeavourSessionId = ROOT): PeerState {
  return {
    version: PEER_STATE_VERSION,
    pairId: peerPairIdFor(endeavourSessionId),
    endeavourSessionId,
    challengerSessionId: challengerSessionIdFor(endeavourSessionId),
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

interface Harness {
  readonly controller: UnifiedModelController
  readonly retained: { target: string; source: string }[]
  readonly released: number
  readonly retainedByTarget: Map<string, number>
}

/**
 * Apply the client plugin over a fake host whose sessions service exposes the
 * installed `retain` shape, then hand back the injected controller.
 */
async function harness(options: {
  readonly peer?: PeerState | null
  readonly withRetain?: boolean
  readonly retainThrows?: Error
  readonly putServiceOnCtx?: boolean
} = {}): Promise<Harness> {
  vi.resetModules()
  const retained: { target: string; source: string }[] = []
  const retainedByTarget = new Map<string, number>()
  let released = 0
  const peer = options.peer === undefined ? peerState() : options.peer
  const retention = {
    retain: (target: string, opts: { source: string }) => {
      if (options.retainThrows !== undefined) throw options.retainThrows
      retained.push({ target, source: opts.source })
      retainedByTarget.set(target, (retainedByTarget.get(target) ?? 0) + 1)
      return {
        ready: Promise.resolve({ id: target }),
        release: () => {
          released += 1
          retainedByTarget.set(target, (retainedByTarget.get(target) ?? 1) - 1)
        },
      }
    },
    binding: (id: string) => (id === ROOT
      ? { session: { projections: { faceOf: (key: string) => (key === 'endeavourPeer' ? { getSnapshot: () => peer } : undefined) } } }
      : undefined),
    list: { getSnapshot: () => ({ current: ROOT }), subscribe: () => () => undefined },
  }
  let injected: UnifiedModelController | undefined
  const fakeClient = {
    effect: () => undefined,
    locale: { register: () => undefined },
    uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
    modelDirectories: { directoryFor: () => undefined },
    // The pre-retain fixture service: no `retain` unless the test supplies one.
    ...(options.withRetain === false ? {} : { sessions: retention }),
    ...(options.putServiceOnCtx === true ? { get: (name: string) => (name === 'sessions' ? retention : undefined) } : {}),
    slots: {
      inject: (_key: string, callback: (sessionId: string) => unknown) => { callback(ROOT) },
      register: (opts: { name: string; inject?: (sessionId: string) => { unifiedModels: UnifiedModelController } }, _component: unknown) => {
        if (opts.name === 'conversation.input.right' && opts.inject !== undefined) {
          injected = opts.inject(ROOT).unifiedModels
        }
        return () => undefined
      },
    },
  }
  const { apply } = await import('../src/client/index.js')
  apply(fakeClient as never)
  if (injected === undefined) throw new Error('bridge test: no controller injected')
  return { controller: injected, retained, get released() { return released }, retainedByTarget }
}

describe('model bridge session acquisition', () => {
  it('retains the exact validated Challenger under this owner source', async () => {
    const h = await harness()
    const lease = h.controller.roles.challenger.acquire?.()
    expect(lease).toBeDefined()
    expect(h.retained).toEqual([{ target: CHALLENGER, source: MODEL_MENU_RETENTION_SOURCE }])
    await expect(lease?.ready).resolves.toBeDefined()
    lease?.release()
    expect(h.released).toBe(1)
  })

  it('releases exactly once even when called twice', async () => {
    const h = await harness()
    const lease = h.controller.roles.challenger.acquire?.()
    lease?.release()
    lease?.release()
    lease?.release()
    expect(h.released).toBe(1)
  })

  it('offers no lease on the Endeavour side, which borrows the main view', async () => {
    const h = await harness()
    expect(h.controller.roles.endeavour.acquire).toBeUndefined()
  })

  it('retains nothing when the peer view is absent or invalid', async () => {
    const absent = await harness({ peer: null })
    expect(absent.controller.roles.challenger.acquire?.()).toBeUndefined()
    expect(absent.retained).toEqual([])

    // A pair state naming a DIFFERENT root must not retain this session's peer.
    const forged = await harness({ peer: peerState(OTHER_ROOT) })
    expect(forged.controller.roles.challenger.acquire?.()).toBeUndefined()
    expect(forged.retained).toEqual([])
    expect(forged.retainedByTarget.has(OTHER_CHALLENGER)).toBe(false)
  })

  it('uses the pre-retain directory path when the host exposes no retain', async () => {
    const h = await harness({ withRetain: false })
    expect(h.controller.roles.challenger.acquire?.()).toBeUndefined()
    expect(h.retained).toEqual([])
  })

  it('propagates a failing retain instead of silently bypassing it', async () => {
    const failure = new Error('ui-model-selection: session "x" resolved no scope')
    const h = await harness({ retainThrows: failure })
    expect(() => h.controller.roles.challenger.acquire?.()).toThrow(failure)
  })

  it('acquires through the official service from ctx.get("sessions")', async () => {
    const h = await harness({ putServiceOnCtx: true })
    const lease = h.controller.roles.challenger.acquire?.()
    expect(lease).toBeDefined()
    expect(h.retained).toEqual([{ target: CHALLENGER, source: MODEL_MENU_RETENTION_SOURCE }])
  })

  it('never retains from admission, availability or a selection read', async () => {
    const h = await harness()
    h.controller.admit?.('endeavour')
    h.controller.roles.challenger.available()
    h.controller.roles.challenger.readSelection()
    h.controller.roles.challenger.available()
    expect(h.retained).toEqual([])
    expect(h.released).toBe(0)
  })
})


interface LockRequest {
  readonly name: string
  readonly mode: 'exclusive'
  readonly signal: AbortSignal
}

interface BrowserMemory {
  readonly storage: Map<string, string>
  readonly lockRequests: LockRequest[]
  setBeforeNextLock(callback: (name: string) => void): void
  restore(): void
}

interface BrowserHarness {
  readonly controller: UnifiedModelController
  readonly peerId: string
  readonly retained: string[]
  readonly released: number
  readonly directoryCalls: string[]
  readonly loads: string[]
  readonly selections: { readonly target: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }[]
  readonly storage: Map<string, string>
  readonly lockRequests: LockRequest[]
  setBeforeNextLock(callback: (name: string) => void): void
  setPeer(peer: PeerState | null): void
  setDirectory(id: string, value: object | undefined): void
  restore(): void
}

const restoreBrowsers: Array<() => void> = []
afterEach(() => { for (const restore of restoreBrowsers.splice(0)) restore() })

function installBrowserMemory(options: { readonly locksAvailable?: boolean } = {}): BrowserMemory {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storage = new Map<string, string>()
  const lockRequests: LockRequest[] = []
  let beforeNextLock: ((name: string) => void) | undefined
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  const locks = options.locksAvailable === false ? undefined : {
    request: async <T>(name: string, lockOptions: { readonly mode: 'exclusive'; readonly signal: AbortSignal }, callback: () => T): Promise<T> => {
      lockRequests.push({ name, mode: lockOptions.mode, signal: lockOptions.signal })
      const before = beforeNextLock
      beforeNextLock = undefined
      before?.(name)
      if (lockOptions.signal.aborted) throw new Error('lock request aborted')
      return callback()
    },
  }
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const browser = {
    location: { origin: 'https://test.desktop' },
    localStorage,
    navigator: { locks },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const values = listeners.get(type) ?? new Set()
      values.add(listener)
      listeners.set(type, values)
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => { listeners.get(type)?.delete(listener) },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  return {
    storage,
    lockRequests,
    setBeforeNextLock: (callback) => { beforeNextLock = callback },
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Object.defineProperty(globalThis, 'window', previous)
    },
  }
}

async function pendingHarness(options: {
  readonly root?: string
  readonly peer?: PeerState | null
  readonly subagent?: boolean
  readonly select?: (target: string, selection: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown> | unknown
  readonly retainReady?: Promise<unknown>
  readonly webLocks?: boolean
} = {}): Promise<BrowserHarness> {
  vi.resetModules()
  const browserMemory = installBrowserMemory({ locksAvailable: options.webLocks !== false })
  restoreBrowsers.push(browserMemory.restore)
  const root = options.root ?? ROOT
  const peerId = challengerSessionIdFor(root)
  let peer = options.peer === undefined ? null : options.peer
  let released = 0
  const retained: string[] = []
  const directoryCalls: string[] = []
  const loads: string[] = []
  const selections: { target: string; provider: string; model: string; reasoningEffort?: string }[] = []
  const peerListeners = new Set<() => void>()
  const directories = new Map<string, object>()
  const directory = (id: string): object => {
    const value = {
      store: { getSnapshot: () => ({ current: { provider: 'root-provider', model: 'root-model' } }), subscribe: () => () => undefined },
      load: async () => { loads.push(id); return { groups: [] } },
      select: async (selection: { provider: string; model: string; reasoningEffort?: string }) => {
        selections.push({ target: id, ...selection })
        return options.select?.(id, selection)
      },
    }
    return value
  }
  directories.set(root, directory(root))
  directories.set(peerId, directory(peerId))
  const retention = {
    retain: (id: string, source: { source: string }) => {
      retained.push(`${id}:${source.source}`)
      return { ready: options.retainReady ?? Promise.resolve({ id }), release: () => { released += 1 } }
    },
    binding: (id: string) => id === root
      ? { session: { meta: options.subagent ? { origin: 'subagent' } : {}, projections: { faceOf: (key: string) => key === 'endeavourPeer'
        ? { getSnapshot: () => peer, subscribe: (listener: () => void) => { peerListeners.add(listener); return () => peerListeners.delete(listener) } }
        : undefined } } }
      : undefined,
    list: { getSnapshot: () => ({ current: root }), subscribe: () => () => undefined },
  }
  let injected: UnifiedModelController | undefined
  const fakeClient = {
    effect: () => undefined,
    locale: { register: () => undefined },
    uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
    modelDirectories: { directoryFor: (id: string) => { directoryCalls.push(id); return directories.get(id) } },
    sessions: retention,
    slots: {
      inject: (_key: string, callback: (sessionId: string) => unknown) => { callback(root) },
      register: (opts: { name: string; inject?: (sessionId: string) => { unifiedModels: UnifiedModelController } }) => {
        if (opts.name === CHALLENGER_MODEL_SEAT && opts.inject !== undefined) injected = opts.inject(root).unifiedModels
        return () => undefined
      },
    },
  }
  const { apply } = await import('../src/client/index.js')
  apply(fakeClient as never)
  if (injected === undefined) throw new Error('pending bridge test: no controller injected')
  return {
    controller: injected,
    peerId,
    retained,
    get released() { return released },
    directoryCalls,
    loads,
    selections,
    storage: browserMemory.storage,
    lockRequests: browserMemory.lockRequests,
    setBeforeNextLock: browserMemory.setBeforeNextLock,
    setPeer: (next) => { peer = next; for (const listener of [...peerListeners]) listener() },
    setDirectory: (id, value) => { if (value === undefined) directories.delete(id); else directories.set(id, value) },
    restore: browserMemory.restore,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('pending Challenger application bridge', () => {
  it('admits an ordinary root before a peer exists and only borrows its directory for catalog reads', async () => {
    const h = await pendingHarness({ peer: null })
    expect(h.controller.admit?.('endeavour')).toBe(true)
    expect(h.controller.sourceSnapshot()).toMatchObject({ mode: 'draft', key: `draft:${ROOT}` })
    const lease = h.controller.roles.challenger.acquire?.()
    expect(lease).toBeUndefined()
    await h.controller.roles.challenger.loadCatalog()
    expect(h.loads).toEqual([ROOT])
    await expect(h.controller.roles.challenger.select('provider', 'model', undefined)).rejects.toThrow('paired Challenger session is unavailable')
    const saved = await h.controller.pendingSelection.save({ provider: 'draft-provider', model: 'draft-model', reasoningEffort: 'high' })
    expect(h.controller.pendingSelection.getSnapshot().record).toEqual(saved)
    expect(h.retained).toEqual([])
    expect(h.selections).toEqual([])
    expect(h.selections.some((entry) => entry.target === ROOT)).toBe(false)
    h.restore()
  })

  it('observes pair appearance, retains only the validated peer and consumes the matching choice once ready', async () => {
    const h = await pendingHarness({ peer: null })
    h.controller.admit?.('endeavour')
    const pending = await h.controller.pendingSelection.save({ provider: 'p', model: 'm', reasoningEffort: 'high' })
    let sourceNotifications = 0
    const unsubscribe = h.controller.subscribeSource(() => { sourceNotifications += 1 })
    h.setPeer(peerState())
    const source = h.controller.sourceSnapshot()
    expect(source).toMatchObject({ mode: 'peer', peerId: CHALLENGER, key: `peer:${CHALLENGER}` })
    expect(sourceNotifications).toBe(1)
    const lease = h.controller.roles.challenger.acquire?.(source.peerId)
    expect(h.retained).toEqual([`${CHALLENGER}:${MODEL_MENU_RETENTION_SOURCE}`])
    await lease?.ready
    expect(await h.controller.applyPendingToPeer(pending.revision, source.peerId!, source.generation)).toBe(true)
    expect(h.selections).toEqual([{ target: CHALLENGER, provider: 'p', model: 'm', reasoningEffort: 'high' }])
    expect(h.controller.pendingSelection.getSnapshot().record).toBeUndefined()
    expect(h.selections.some((entry) => entry.target === ROOT)).toBe(false)
    lease?.release()
    unsubscribe()
    expect(h.released).toBe(1)
    h.restore()
  })

  it('leaves returned ok:false and rejected selections pending for a deliberate retry', async () => {
    let rejected = false
    const h = await pendingHarness({
      peer: peerState(),
      select: () => rejected ? Promise.reject(new Error('remote rejected')) : { ok: false, error: 'not accepted' },
    })
    h.controller.admit?.('endeavour')
    const source = h.controller.sourceSnapshot()
    const record = await h.controller.pendingSelection.save({ provider: 'p', model: 'm' })
    await expect(h.controller.applyPendingToPeer(record.revision, source.peerId!, source.generation)).rejects.toThrow('not accepted')
    expect(h.controller.pendingSelection.getSnapshot().record?.revision).toBe(record.revision)
    expect(h.selections).toHaveLength(1)
    rejected = true
    await expect(h.controller.applyPendingToPeer(record.revision, source.peerId!, source.generation)).rejects.toThrow('remote rejected')
    expect(h.controller.pendingSelection.getSnapshot().record?.revision).toBe(record.revision)
    expect(h.selections).toHaveLength(2)
    h.restore()
  })

  it('serializes attempts, never lets an older settlement clear a newer revision, then applies the latest choice', async () => {
    const firstWrite = deferred<unknown>()
    const secondWrite = deferred<unknown>()
    let calls = 0
    const h = await pendingHarness({ peer: peerState(), select: () => (++calls === 1 ? firstWrite.promise : secondWrite.promise) })
    h.controller.admit?.('endeavour')
    const source = h.controller.sourceSnapshot()
    const old = await h.controller.pendingSelection.save({ provider: 'p', model: 'old' })
    const first = h.controller.applyPendingToPeer(old.revision, source.peerId!, source.generation)
    await Promise.resolve()
    const newer = await h.controller.pendingSelection.save({ provider: 'p', model: 'new' })
    const second = h.controller.applyPendingToPeer(newer.revision, source.peerId!, source.generation)
    firstWrite.resolve(undefined)
    expect(await first).toBe(false)
    await Promise.resolve()
    secondWrite.resolve({ ok: true })
    expect(await second).toBe(true)
    expect(h.selections.map((entry) => entry.model)).toEqual(['old', 'new'])
    expect(h.controller.pendingSelection.getSnapshot().record).toBeUndefined()
    h.restore()
  })

  it('does not consume a pending choice after the source generation changes in flight', async () => {
    const write = deferred<unknown>()
    const h = await pendingHarness({ peer: peerState(), select: () => write.promise })
    h.controller.admit?.('endeavour')
    const source = h.controller.sourceSnapshot()
    const record = await h.controller.pendingSelection.save({ provider: 'p', model: 'm' })
    const attempt = h.controller.applyPendingToPeer(record.revision, source.peerId!, source.generation)
    await Promise.resolve()
    h.controller.admit?.('standard')
    write.resolve(undefined)
    expect(await attempt).toBe(false)
    expect(h.controller.sourceSnapshot().mode).toBe('hidden')
    h.controller.admit?.('endeavour')
    expect(h.controller.pendingSelection.getSnapshot().record?.revision).toBe(record.revision)
    h.restore()
  })

  it('uses an exclusive native lock named by the exact origin and root storage key', async () => {
    const h = await pendingHarness({ peer: null })
    h.controller.admit?.('endeavour')
    await h.controller.pendingSelection.save({ provider: 'p', model: 'm' })
    const key = challengerSelectionStorageKey('https://test.desktop', ROOT)
    expect(h.lockRequests).toHaveLength(1)
    expect(h.lockRequests[0]).toMatchObject({ name: key, mode: 'exclusive' })
    expect(h.lockRequests[0]?.signal.aborted).toBe(false)
    expect(h.storage.has(key)).toBe(true)
    h.restore()
  })

  it('fails closed when native Web Locks are unavailable', async () => {
    const h = await pendingHarness({ peer: null, webLocks: false })
    h.controller.admit?.('endeavour')
    await expect(h.controller.pendingSelection.save({ provider: 'p', model: 'm' })).rejects.toThrow('Could not save the Challenger choice in this browser.')
    expect(h.controller.pendingSelection.getSnapshot().error).toBe('Could not save the Challenger choice in this browser.')
    expect(h.storage.size).toBe(0)
    h.restore()
  })

  it('returns false and refreshes a newer durable revision before removing the old one', async () => {
    const h = await pendingHarness({ peer: peerState() })
    h.controller.admit?.('endeavour')
    const source = h.controller.sourceSnapshot()
    const old = await h.controller.pendingSelection.save({ provider: 'p', model: 'old' })
    const key = challengerSelectionStorageKey('https://test.desktop', ROOT)
    const newer = { schemaVersion: 1, revision: 'external-newer', provider: 'p', model: 'newer' }
    h.setBeforeNextLock((name) => {
      expect(name).toBe(key)
      h.storage.set(key, JSON.stringify(newer))
    })
    expect(await h.controller.applyPendingToPeer(old.revision, source.peerId!, source.generation)).toBe(false)
    expect(h.controller.pendingSelection.getSnapshot().record).toEqual(newer)
    expect(JSON.parse(h.storage.get(key) ?? 'null')).toEqual(newer)
    expect(h.selections.map((entry) => entry.model)).toEqual(['old'])
    h.restore()
  })

  it('does not admit known subagents or validated Challenger-side sessions', async () => {
    const subagent = await pendingHarness({ peer: null, subagent: true })
    expect(subagent.controller.admit?.('endeavour')).toBe(false)
    expect(subagent.controller.sourceSnapshot().mode).toBe('hidden')
    subagent.restore()
    const challengerSide = await pendingHarness({ root: CHALLENGER, peer: peerState(ROOT) })
    expect(challengerSide.controller.admit?.('endeavour')).toBe(false)
    expect(challengerSide.controller.sourceSnapshot().mode).toBe('hidden')
    expect(challengerSide.retained).toEqual([])
    challengerSide.restore()
  })
})
