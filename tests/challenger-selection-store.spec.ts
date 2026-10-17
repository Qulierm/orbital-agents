/**
 * Browser-local pending Challenger selection store tests.
 *
 * Each test owns its storage, event target and exclusive-lock coordinator, so no
 * user browser storage, profile state or session data is involved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  challengerSelectionStorageKey,
  createPendingChallengerSelectionStore,
  type ChallengerSelectionLockProvider,
  type ChallengerSelectionStorage,
  type ChallengerStorageEvent,
  type ChallengerStorageEventTarget,
} from '../src/client/challenger-selection-store.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface LockGate {
  readonly entered: Promise<void>
  readonly wait: Promise<void>
  arrive(): void
  release(): void
}

interface LockWaiter {
  readonly signal: AbortSignal
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  readonly abort: () => void
}

/** Per-test exclusive coordinator with explicit barriers for contention tests. */
class MemoryLocks implements ChallengerSelectionLockProvider {
  readonly names: string[] = []
  readonly maxActive = new Map<string, number>()
  failNext = false
  private readonly locked = new Set<string>()
  private readonly active = new Map<string, number>()
  private readonly queues = new Map<string, LockWaiter[]>()
  private readonly queueListeners = new Map<string, Set<() => void>>()
  private readonly gates = new Map<string, LockGate[]>()

  holdNext(name: string): Pick<LockGate, 'entered' | 'release'> {
    const entered = deferred<void>()
    const released = deferred<void>()
    const gate: LockGate = {
      entered: entered.promise,
      wait: released.promise,
      arrive: () => entered.resolve(),
      release: () => released.resolve(),
    }
    const queue = this.gates.get(name) ?? []
    queue.push(gate)
    this.gates.set(name, queue)
    return { entered: gate.entered, release: gate.release }
  }

  queued(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }

  waitForQueued(name: string, count: number): Promise<void> {
    if (this.queued(name) >= count) return Promise.resolve()
    return new Promise((resolve) => {
      const listeners = this.queueListeners.get(name) ?? new Set<() => void>()
      const check = (): void => {
        if (this.queued(name) < count) return
        listeners.delete(check)
        if (listeners.size === 0) this.queueListeners.delete(name)
        resolve()
      }
      listeners.add(check)
      this.queueListeners.set(name, listeners)
    })
  }

  async request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly signal: AbortSignal },
    callback: () => T,
  ): Promise<T> {
    this.names.push(name)
    if (this.failNext) {
      this.failNext = false
      throw new Error('lock unavailable')
    }
    if (options.mode !== 'exclusive') throw new Error('exclusive mode required')
    await this.acquire(name, options.signal)
    const active = (this.active.get(name) ?? 0) + 1
    this.active.set(name, active)
    this.maxActive.set(name, Math.max(this.maxActive.get(name) ?? 0, active))
    try {
      const gate = this.gates.get(name)?.shift()
      if (gate) {
        gate.arrive()
        await gate.wait
      }
      if (options.signal.aborted) throw new Error('lock request aborted')
      return callback()
    } finally {
      const remaining = (this.active.get(name) ?? 1) - 1
      if (remaining === 0) this.active.delete(name)
      else this.active.set(name, remaining)
      this.release(name)
    }
  }

  private async acquire(name: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('lock request aborted')
    if (!this.locked.has(name)) {
      this.locked.add(name)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(name) ?? []
      let waiter: LockWaiter
      const abort = (): void => {
        const index = queue.indexOf(waiter)
        if (index >= 0) queue.splice(index, 1)
        signal.removeEventListener('abort', abort)
        reject(new Error('lock request aborted'))
        this.notifyQueue(name)
      }
      waiter = { signal, resolve, reject, abort }
      queue.push(waiter)
      this.queues.set(name, queue)
      signal.addEventListener('abort', abort, { once: true })
      this.notifyQueue(name)
      if (signal.aborted) abort()
    })
  }

  private release(name: string): void {
    const queue = this.queues.get(name)
    while (queue?.length) {
      const waiter = queue.shift()!
      waiter.signal.removeEventListener('abort', waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(new Error('lock request aborted'))
        continue
      }
      waiter.resolve()
      this.notifyQueue(name)
      return
    }
    this.queues.delete(name)
    this.locked.delete(name)
    this.notifyQueue(name)
  }

  private notifyQueue(name: string): void {
    for (const listener of [...(this.queueListeners.get(name) ?? [])]) listener()
  }
}

class MemoryStorage implements ChallengerSelectionStorage {
  readonly values = new Map<string, string>()
  readonly locks = new MemoryLocks()
  failRead = false
  failWrite = false
  failRemove = false

  getItem(key: string): string | null {
    if (this.failRead) throw new Error('read denied')
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error('write denied')
    this.values.set(key, value)
  }
  removeItem(key: string): void {
    if (this.failRemove) throw new Error('remove denied')
    this.values.delete(key)
  }
}

class MemoryEvents implements ChallengerStorageEventTarget {
  readonly listeners = new Set<(event: ChallengerStorageEvent) => void>()
  addEventListener(_type: 'storage', listener: (event: ChallengerStorageEvent) => void): void { this.listeners.add(listener) }
  removeEventListener(_type: 'storage', listener: (event: ChallengerStorageEvent) => void): void { this.listeners.delete(listener) }
  dispatch(event: ChallengerStorageEvent): void { for (const listener of [...this.listeners]) listener(event) }
}

const stores: Array<{ dispose(): void }> = []
afterEach(() => { for (const store of stores.splice(0)) store.dispose() })

function store(
  storage = new MemoryStorage(),
  events = new MemoryEvents(),
  rootSessionId = 'session-root',
  origin = 'https://desktop.example',
  createRevision: () => string = () => 'rev-1',
) {
  const value = createPendingChallengerSelectionStore({
    storage,
    lockProvider: storage.locks,
    eventTarget: events,
    rootSessionId,
    origin,
    createRevision,
  })
  stores.push(value)
  return { value, storage, events }
}

describe('pending Challenger selection store', () => {
  it('uses a versioned exact-origin and exact-root key', () => {
    expect(challengerSelectionStorageKey('https://desktop.example', 'session/a'))
      .toBe('dsh-orbital-agents:challenger-selection:v1:https%3A%2F%2Fdesktop.example:session%2Fa')
    expect(challengerSelectionStorageKey('https://desktop.example', 'session-a'))
      .not.toBe(challengerSelectionStorageKey('https://desktop.example', 'session-b'))
  })

  it('persists before publishing and restores the pending choice after remount', async () => {
    const storage = new MemoryStorage()
    const first = store(storage)
    const notifications: number[] = []
    first.value.subscribe(() => notifications.push(1))
    const record = await first.value.save({ provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' })
    expect(record).toEqual({ schemaVersion: 1, revision: 'rev-1', provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' })
    expect(storage.values.get(first.value.key)).toBe(JSON.stringify(record))
    expect(first.value.getSnapshot().record).toBe(record)
    expect(notifications).toHaveLength(1)

    first.value.dispose()
    const second = store(storage)
    expect(second.value.getSnapshot().record).toEqual(record)
  })

  it('keeps different root sessions and origins isolated', async () => {
    const storage = new MemoryStorage()
    const a = store(storage, new MemoryEvents(), 'session-a')
    const b = store(storage, new MemoryEvents(), 'session-b')
    const otherOrigin = store(storage, new MemoryEvents(), 'session-a', 'https://other.example')
    await a.value.save({ provider: 'p1', model: 'm1' })
    expect(b.value.getSnapshot().record).toBeUndefined()
    expect(otherOrigin.value.getSnapshot().record).toBeUndefined()
    expect(new Set([a.value.key, b.value.key, otherOrigin.value.key]).size).toBe(3)
  })

  it('synchronizes same-document stores with the same exact key', async () => {
    const storage = new MemoryStorage()
    const a = store(storage)
    const b = store(storage)
    let notifications = 0
    b.value.subscribe(() => { notifications += 1 })
    const record = await a.value.save({ provider: 'p2', model: 'm2' })
    expect(b.value.getSnapshot().record).toEqual(record)
    expect(notifications).toBe(1)
  })

  it('rereads durable storage for exact-key events instead of trusting stale event values', () => {
    const storage = new MemoryStorage()
    const events = new MemoryEvents()
    const x = store(storage, events)
    const y = store(storage, new MemoryEvents(), 'session-other')
    const old = { schemaVersion: 1 as const, revision: 'external-old', provider: 'p1', model: 'm1' }
    const newer = { schemaVersion: 1 as const, revision: 'external-new', provider: 'p2', model: 'm2' }
    events.dispatch({ key: y.value.key, newValue: JSON.stringify(old) })
    expect(x.value.getSnapshot().record).toBeUndefined()

    storage.values.set(x.value.key, JSON.stringify(old))
    events.dispatch({ key: x.value.key, newValue: JSON.stringify(old) })
    expect(x.value.getSnapshot().record).toEqual(old)
    storage.values.set(x.value.key, JSON.stringify(newer))
    events.dispatch({ key: x.value.key, newValue: JSON.stringify(old) })
    expect(x.value.getSnapshot().record).toEqual(newer)

    const unchanged = x.value.getSnapshot()
    let notifications = 0
    x.value.subscribe(() => { notifications += 1 })
    events.dispatch({ key: x.value.key, newValue: JSON.stringify(old) })
    expect(x.value.getSnapshot()).toBe(unchanged)
    expect(notifications).toBe(0)

    storage.values.delete(x.value.key)
    events.dispatch({ key: x.value.key, newValue: JSON.stringify(newer) })
    expect(x.value.getSnapshot().record).toBeUndefined()
  })

  it('reports corrupt JSON and unknown schema versions instead of treating them as empty', () => {
    const storage = new MemoryStorage()
    const events = new MemoryEvents()
    const x = store(storage, events)
    storage.values.set(x.value.key, '{broken')
    const corrupt = store(storage, new MemoryEvents())
    expect(corrupt.value.getSnapshot().error).toBe('Saved Challenger choice is unreadable.')
    const unsupported = { schemaVersion: 2, revision: 'r', provider: 'p', model: 'm' }
    storage.values.set(x.value.key, JSON.stringify(unsupported))
    events.dispatch({ key: x.value.key, newValue: JSON.stringify({ schemaVersion: 1, revision: 'r', provider: 'p', model: 'm' }) })
    expect(x.value.getSnapshot().record).toBeUndefined()
    expect(x.value.getSnapshot().error).toContain('unsupported version')
  })

  it('contains read and write failures and never reports a failed write as saved', async () => {
    const storage = new MemoryStorage()
    storage.failRead = true
    const x = store(storage)
    expect(x.value.getSnapshot().error).toContain('could not be read')
    storage.failRead = false
    storage.failWrite = true
    await expect(x.value.save({ provider: 'p1', model: 'm1' })).rejects.toThrow('Could not save the Challenger choice')
    expect(x.value.getSnapshot().record).toBeUndefined()
    expect(x.value.getSnapshot().error).toContain('Could not save')
    expect(storage.values.has(x.value.key)).toBe(false)
  })

  it('fails closed when lock coordination is unavailable', async () => {
    const storage = new MemoryStorage()
    const x = store(storage)
    storage.locks.failNext = true
    await expect(x.value.save({ provider: 'p1', model: 'm1' })).rejects.toThrow('Could not save the Challenger choice')
    expect(x.value.getSnapshot().record).toBeUndefined()
    expect(x.value.getSnapshot().error).toContain('Could not save')
    expect(storage.values.has(x.value.key)).toBe(false)

    const saved = await x.value.save({ provider: 'p1', model: 'm1' })
    storage.locks.failNext = true
    await expect(x.value.removeIfRevision(saved.revision)).rejects.toThrow('Could not clear the applied Challenger choice')
    expect(storage.values.get(x.value.key)).toBe(JSON.stringify(saved))
    expect(x.value.getSnapshot().error).toContain('Could not clear')
    expect(storage.locks.names).toEqual([x.value.key, x.value.key, x.value.key])
  })

  it('does not clear a newer revision when an older write settles', async () => {
    const storage = new MemoryStorage()
    let revision = 0
    const x = store(storage, new MemoryEvents(), 'session-root', 'https://desktop.example', () => `rev-${++revision}`)
    const old = await x.value.save({ provider: 'p1', model: 'm1' })
    const newer = await x.value.save({ provider: 'p2', model: 'm2', reasoningEffort: 'high' })
    expect(await x.value.removeIfRevision(old.revision)).toBe(false)
    expect(storage.values.get(x.value.key)).toBe(JSON.stringify(newer))
    expect(x.value.getSnapshot().record).toEqual(newer)
    expect(await x.value.removeIfRevision(newer.revision)).toBe(true)
    expect(storage.values.has(x.value.key)).toBe(false)
  })

  it('preserves a newer durable revision while this tab has not received its storage event', async () => {
    const storage = new MemoryStorage()
    const events = new MemoryEvents()
    const x = store(storage, events)
    const old = await x.value.save({ provider: 'p1', model: 'm1' })
    const newer = { schemaVersion: 1 as const, revision: 'rev-2', provider: 'p2', model: 'm2' }
    // Another browser context writes the durable value; this tab's cache/event is deliberately stale.
    storage.values.set(x.value.key, JSON.stringify(newer))
    expect(x.value.getSnapshot().record).toEqual(old)

    const removed = await x.value.removeIfRevision(old.revision)
    expect(storage.values.get(x.value.key)).toBe(JSON.stringify(newer))
    expect(removed).toBe(false)
    expect(x.value.getSnapshot().record).toEqual(newer)
  })

  it('preserves corrupt and unsupported durable values instead of removing them', async () => {
    for (const raw of [
      '{broken',
      JSON.stringify({ schemaVersion: 2, revision: 'rev-2', provider: 'p2', model: 'm2' }),
    ]) {
      const storage = new MemoryStorage()
      const x = store(storage)
      const record = await x.value.save({ provider: 'p1', model: 'm1' })
      storage.values.set(x.value.key, raw)
      await expect(x.value.removeIfRevision(record.revision)).rejects.toThrow(/unreadable|unsupported version/)
      expect(storage.values.get(x.value.key)).toBe(raw)
      expect(x.value.getSnapshot().error).toMatch(/unreadable|unsupported version/)
      await expect(x.value.save({ provider: 'p3', model: 'm3' })).rejects.toThrow(/unreadable|unsupported version/)
      expect(storage.values.get(x.value.key)).toBe(raw)
    }
  })

  it('serializes removal before a queued save and never overlaps critical sections', async () => {
    const storage = new MemoryStorage()
    let revision = 0
    const x = store(storage, new MemoryEvents(), 'session-root', 'https://desktop.example', () => `rev-${++revision}`)
    const old = await x.value.save({ provider: 'p1', model: 'm1' })
    const gate = storage.locks.holdNext(x.value.key)
    const removing = x.value.removeIfRevision(old.revision)
    await gate.entered
    const saving = x.value.save({ provider: 'p2', model: 'm2' })
    await storage.locks.waitForQueued(x.value.key, 1)
    expect(storage.locks.maxActive.get(x.value.key)).toBe(1)
    gate.release()

    expect(await removing).toBe(true)
    const saved = await saving
    expect(storage.values.get(x.value.key)).toBe(JSON.stringify(saved))
    expect(saved.revision).toBe('rev-2')
    expect(storage.locks.maxActive.get(x.value.key)).toBe(1)
    expect(storage.locks.names.every((name) => name === x.value.key)).toBe(true)
  })

  it('serializes a save before queued removal and preserves the newest revision', async () => {
    const storage = new MemoryStorage()
    let revision = 0
    const x = store(storage, new MemoryEvents(), 'session-root', 'https://desktop.example', () => `rev-${++revision}`)
    const old = await x.value.save({ provider: 'p1', model: 'm1' })
    const gate = storage.locks.holdNext(x.value.key)
    const saving = x.value.save({ provider: 'p2', model: 'm2' })
    await gate.entered
    const removing = x.value.removeIfRevision(old.revision)
    await storage.locks.waitForQueued(x.value.key, 1)
    expect(storage.locks.maxActive.get(x.value.key)).toBe(1)
    gate.release()

    const saved = await saving
    expect(await removing).toBe(false)
    expect(storage.values.get(x.value.key)).toBe(JSON.stringify(saved))
    expect(x.value.getSnapshot().record).toEqual(saved)
    expect(storage.locks.maxActive.get(x.value.key)).toBe(1)
  })

  it('reports remove failure and leaves the outstanding record visible', async () => {
    const storage = new MemoryStorage()
    const x = store(storage)
    const record = await x.value.save({ provider: 'p1', model: 'm1' })
    storage.failRemove = true
    await expect(x.value.removeIfRevision(record.revision)).rejects.toThrow('Could not clear the applied Challenger choice')
    expect(x.value.getSnapshot().record).toEqual(record)
    expect(x.value.getSnapshot().error).toContain('Could not clear')
  })

  it('reports durable read failure without removing the cached revision', async () => {
    const storage = new MemoryStorage()
    const x = store(storage)
    const record = await x.value.save({ provider: 'p1', model: 'm1' })
    const raw = storage.values.get(x.value.key)
    storage.failRead = true
    await expect(x.value.removeIfRevision(record.revision)).rejects.toThrow('Saved Challenger choice could not be read')
    expect(storage.values.get(x.value.key)).toBe(raw)
    expect(x.value.getSnapshot().error).toContain('could not be read')
  })

  it('aborts queued mutations on disposal without writing or publishing', async () => {
    const storage = new MemoryStorage()
    const holder = store(storage)
    const waiting = store(storage)
    const gate = storage.locks.holdNext(holder.value.key)
    const heldSave = holder.value.save({ provider: 'p1', model: 'm1' })
    await gate.entered
    let notifications = 0
    waiting.value.subscribe(() => { notifications += 1 })
    const queuedSave = waiting.value.save({ provider: 'p2', model: 'm2' })
    await storage.locks.waitForQueued(holder.value.key, 1)
    waiting.value.dispose()
    await expect(queuedSave).rejects.toThrow('disposed')
    expect(notifications).toBe(0)
    expect(storage.values.has(waiting.value.key)).toBe(false)
    gate.release()
    await heldSave
    expect(storage.values.get(holder.value.key)).toContain('"model":"m1"')
    expect(notifications).toBe(0)
  })

  it('disposes its storage listener and same-document membership', async () => {
    const storage = new MemoryStorage()
    const events = new MemoryEvents()
    const a = store(storage, events)
    const b = store(storage)
    const c = store(storage)
    let aNotifications = 0
    let cNotifications = 0
    a.value.subscribe(() => { aNotifications += 1 })
    c.value.subscribe(() => { cNotifications += 1 })
    expect(events.listeners.size).toBe(1)
    const aSnapshot = a.value.getSnapshot()
    a.value.dispose()
    expect(events.listeners.size).toBe(0)
    const record = await b.value.save({ provider: 'p', model: 'm' })
    expect(c.value.getSnapshot().record).toEqual(record)
    expect(cNotifications).toBe(1)
    expect(a.value.getSnapshot()).toBe(aSnapshot)
    expect(aNotifications).toBe(0)
  })
})
