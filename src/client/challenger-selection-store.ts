/**
 * Browser-local pending Challenger selection.
 *
 * A choice made before a validated peer is ready belongs only to this browser
 * origin and Endeavour root session. The record is deliberately limited to the
 * model selection — never settings, credentials, provider configuration or
 * session data. The store persists before it publishes success, synchronizes
 * other store instances in this document and matching browser `storage` events,
 * and removes a value only when its revision is still current.
 */

/** The record written for one explicit Challenger choice. */
export interface PendingChallengerSelection {
  readonly schemaVersion: 1
  readonly revision: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Readable state for the trigger/menu; invalid stored data is visible as error. */
export interface PendingChallengerSelectionSnapshot {
  readonly record?: PendingChallengerSelection
  readonly error?: string
}

/** Small Storage surface used by the browser and by deterministic tests. */
export interface ChallengerSelectionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The exact browser event fields this store observes. */
export interface ChallengerStorageEvent {
  readonly key: string | null
  readonly newValue: string | null
}

/** Injectable event target; browser storage and test fakes share this surface. */
export interface ChallengerStorageEventTarget {
  addEventListener(type: 'storage', listener: (event: ChallengerStorageEvent) => void): void
  removeEventListener(type: 'storage', listener: (event: ChallengerStorageEvent) => void): void
}

/** Origin-wide exclusive lock provider used for every mutation of one storage key. */
export interface ChallengerSelectionLockProvider {
  request<T>(
    name: string,
    options: { readonly mode: 'exclusive'; readonly signal: AbortSignal },
    callback: () => T,
  ): Promise<T>
}

export interface PendingChallengerSelectionStoreOptions {
  readonly storage: ChallengerSelectionStorage
  readonly lockProvider: ChallengerSelectionLockProvider
  readonly origin: string
  readonly rootSessionId: string
  readonly eventTarget?: ChallengerStorageEventTarget
  /** Injectable only to make revision assertions deterministic in tests. */
  readonly createRevision?: () => string
}

/** Storage key is unique to one desktop origin and exact Endeavour root id. */
export function challengerSelectionStorageKey(origin: string, rootSessionId: string): string {
  if (origin === '') throw new Error('pending Challenger selection: origin must not be empty')
  if (rootSessionId === '') throw new Error('pending Challenger selection: root session id must not be empty')
  return `dsh-orbital-agents:challenger-selection:v1:${encodeURIComponent(origin)}:${encodeURIComponent(rootSessionId)}`
}

interface InternalSnapshot extends PendingChallengerSelectionSnapshot {}

/** All live same-document stores, grouped by their exact key. */
const sameDocumentStores = new Map<string, Set<PendingChallengerSelectionStore>>()
let fallbackRevision = 0

function defaultRevision(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  fallbackRevision += 1
  return `${Date.now().toString(36)}-${fallbackRevision.toString(36)}-${Math.random().toString(36).slice(2)}`
}

function validSelection(value: unknown): value is { provider: string; model: string; reasoningEffort?: string } {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.provider === 'string' && record.provider.trim() !== ''
    && typeof record.model === 'string' && record.model.trim() !== ''
    && (record.reasoningEffort === undefined
      || (typeof record.reasoningEffort === 'string' && record.reasoningEffort.trim() !== ''))
}

function parseRecord(raw: string | null): InternalSnapshot {
  if (raw === null) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { error: 'Saved Challenger choice is unreadable.' }
  }
  if (typeof value !== 'object' || value === null) return { error: 'Saved Challenger choice is invalid.' }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) return { error: 'Saved Challenger choice uses an unsupported version.' }
  const revision = record.revision
  if (typeof revision !== 'string' || revision.trim() === '' || !validSelection(record)) {
    return { error: 'Saved Challenger choice is invalid.' }
  }
  const parsed: PendingChallengerSelection = {
    schemaVersion: 1,
    revision,
    provider: record.provider as string,
    model: record.model as string,
    ...(typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {}),
  }
  return { record: parsed }
}

function sameRecord(left: PendingChallengerSelection | undefined, right: PendingChallengerSelection | undefined): boolean {
  return left === right || (left !== undefined && right !== undefined
    && left.schemaVersion === right.schemaVersion
    && left.revision === right.revision
    && left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort)
}

const DISPOSED_ERROR = 'pending Challenger selection store is disposed'
const READ_ERROR = 'Saved Challenger choice could not be read from browser storage.'
const SAVE_ERROR = 'Could not save the Challenger choice in this browser.'
const REMOVE_ERROR = 'Could not clear the applied Challenger choice from this browser.'

/** One owner for one root's browser-local pending selection. */
export class PendingChallengerSelectionStore {
  readonly key: string
  private snapshot: InternalSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly options: PendingChallengerSelectionStoreOptions
  private readonly abortController = new AbortController()
  private disposed = false
  private readonly onStorage = (event: ChallengerStorageEvent): void => {
    if (this.disposed || event.key !== this.key) return
    this.publish(this.readStorage(), false)
  }

  constructor(options: PendingChallengerSelectionStoreOptions) {
    this.options = options
    this.key = challengerSelectionStorageKey(options.origin, options.rootSessionId)
    this.snapshot = this.readStorage()
    options.eventTarget?.addEventListener('storage', this.onStorage)
    const peers = sameDocumentStores.get(this.key) ?? new Set<PendingChallengerSelectionStore>()
    peers.add(this)
    sameDocumentStores.set(this.key, peers)
  }

  /** Stable snapshot identity until the stored record or visible error changes. */
  getSnapshot = (): PendingChallengerSelectionSnapshot => this.snapshot

  /** Subscribe to writes and matching storage events until disposed. */
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  /** Persist one explicit choice under the exact-key origin-wide exclusive lock. */
  async save(selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }): Promise<PendingChallengerSelection> {
    this.assertLive()
    if (!validSelection(selection)) throw new Error('pending Challenger selection: provider and model must be non-empty')
    return this.withExclusiveLock(SAVE_ERROR, () => {
      const current = this.readDurableUnderLock()
      this.assertLive()
      const record: PendingChallengerSelection = {
        schemaVersion: 1,
        revision: (this.options.createRevision ?? defaultRevision)(),
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      }
      try {
        this.options.storage.setItem(this.key, JSON.stringify(record))
      } catch {
        this.publish({ ...current, error: SAVE_ERROR }, true)
        throw new Error(SAVE_ERROR)
      }
      this.publish({ record }, true)
      return record
    })
  }

  /** Remove only the durable outstanding revision that completed successfully. */
  async removeIfRevision(revision: string): Promise<boolean> {
    this.assertLive()
    return this.withExclusiveLock(REMOVE_ERROR, () => {
      const current = this.readDurableUnderLock()
      if (current.record?.revision !== revision) return false
      this.assertLive()
      try {
        this.options.storage.removeItem(this.key)
      } catch {
        this.publish({ ...current, error: REMOVE_ERROR }, true)
        throw new Error(REMOVE_ERROR)
      }
      this.publish({}, true)
      return true
    })
  }

  /** Remove listeners and same-document membership; this store cannot be reused. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
    this.options.eventTarget?.removeEventListener('storage', this.onStorage)
    const peers = sameDocumentStores.get(this.key)
    peers?.delete(this)
    if (peers?.size === 0) sameDocumentStores.delete(this.key)
    this.listeners.clear()
  }

  private readStorage(): InternalSnapshot {
    try {
      return parseRecord(this.options.storage.getItem(this.key))
    } catch {
      return { error: READ_ERROR }
    }
  }

  private readDurableUnderLock(): InternalSnapshot {
    const current = this.readStorage()
    this.publish(current, true)
    if (current.error !== undefined) throw new Error(current.error)
    return current
  }

  private async withExclusiveLock<T>(failureMessage: string, operation: () => T): Promise<T> {
    this.assertLive()
    let callbackEntered = false
    try {
      return await this.options.lockProvider.request(this.key, {
        mode: 'exclusive',
        signal: this.abortController.signal,
      }, () => {
        callbackEntered = true
        this.assertLive()
        return operation()
      })
    } catch (error) {
      if (this.disposed) throw new Error(DISPOSED_ERROR)
      if (callbackEntered) throw error
      this.publish({ ...this.snapshot, error: failureMessage }, true)
      throw new Error(failureMessage)
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error(DISPOSED_ERROR)
  }

  private publish(next: InternalSnapshot, broadcast: boolean): void {
    if (this.disposed || (sameRecord(this.snapshot.record, next.record) && this.snapshot.error === next.error)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
    if (!broadcast) return
    for (const peer of sameDocumentStores.get(this.key) ?? []) {
      if (peer !== this) peer.publish(next, false)
    }
  }
}

/** Construct an isolated store for one origin and Endeavour root. */
export function createPendingChallengerSelectionStore(
  options: PendingChallengerSelectionStoreOptions,
): PendingChallengerSelectionStore {
  return new PendingChallengerSelectionStore(options)
}
