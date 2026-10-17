/** Browser plugin entry: plan definition, English copy, transcript card, dock. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { endeavourPlanDefinition } from './definition.js'
import { endeavourPeerNodeDefinition, endeavourPeerViewDefinition, PEER_ACTIVITY_TARGET } from './peer-activity.js'
import { PlanCard, type EndeavourInjected, type PlanCardProps } from './PlanCard.js'
import { registerPlanDock } from './PlanDock.js'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  ChallengerModelControl,
  type UnifiedModelController,
  type UnifiedRole,
  type UnifiedRoleController,
  type UnifiedRoleLease,
  type UnifiedSelection,
  type UnifiedModelSourceSnapshot,
} from './UnifiedModelControl.js'
import { createPendingChallengerSelectionStore, type ChallengerSelectionLockProvider, type PendingChallengerSelectionSnapshot } from './challenger-selection-store.js'

const browserSelectionLockProvider: ChallengerSelectionLockProvider = {
  request: (name, options, callback) => {
    const locks = typeof window === 'undefined' ? undefined : window.navigator?.locks
    if (locks === undefined || typeof locks.request !== 'function') return Promise.reject(new Error('Web Locks API is unavailable.'))
    return locks.request(name, { mode: 'exclusive', signal: options.signal }, () => callback())
  },
}

/**
 * The official ModelDirectory resolver fails loud for a session that has no live
 * scope or UI binding (`ui-model-selection: session "X" resolved no scope|no
 * binding`). For a paired peer that state is transient — the session can be
 * alive without being bound yet — so the bridge reports it as "this role is
 * unavailable right now" instead of letting a render-time throw unmount the
 * composer control. Every other failure keeps propagating.
 */
export function isUnavailableSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /ui-model-selection: session ".*" resolved no (?:scope|binding)/.test(error.message)
}

/**
 * Retention face of the installed Session Controller. The repository dev types
 * predate `retain`, so this narrow structural view names exactly what the bridge
 * calls; the installed package is the runtime authority for its behavior. A host
 * without `retain` keeps the pre-retain directory behavior.
 */
interface SessionsRetention {
  readonly retain?: (target: SessionId, options: { readonly source: string }) => {
    readonly ready: Promise<unknown>
    readonly release: () => void
  }
}

/**
 * Retention source this menu owns the peer under. Distinct per owner so the
 * reference count and the release that decrements it stay attributable.
 */
export const MODEL_MENU_RETENTION_SOURCE = 'orbitalModelMenu'

/**
 * Composer seat the Challenger selector registers in.
 *
 * The neighbouring `conversation.input.model` seat is single-occupancy and DSH's
 * own Endeavour selector already holds it, so a second registration at the same
 * priority is rejected. That rejection happens while this plugin activates, so it
 * fails the whole client module rather than one control. This seat is a `list`:
 * several controls coexist and `order` sequences them.
 */
export const CHALLENGER_MODEL_SEAT = 'conversation.input.right'

/** Structural view of the official ModelDirectory the native selector uses. */
interface DirectoryLike {
  readonly store?: {
    getSnapshot?(): {
      readonly current?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } | null
    }
    subscribe?(listener: () => void): () => void
  }
  load?(): Promise<unknown>
  select?(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> | unknown
}
import { en, NS, type EndeavourKey } from './locales.js'
import { ensurePlanStyles } from './styles.js'
import { peerView } from '../peer-projection.js'
import { validatePeerState } from '../peer.js'
import type { PeerState } from '../peer.js'
import {
  hasTransientUserActivation,
  openPeerTab,
  peerTabTarget,
  reconcilePeerActivity,
  reconcilePeerTab,
  registerPeerTabEntry,
  type PeerProjectionFace,
} from './peer-tab.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Endeavour plan copy (English only, all locales). */
    endeavour: EndeavourKey
  }
}

/** Narrow view of the client services this plugin consumes. */
interface ClientServices {
  readonly modelDirectories?: {
    directoryFor?(sessionId: string): {
      readonly store?: {
        getSnapshot?(): {
          readonly current?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } | null
        }
        subscribe?(listener: () => void): () => void
      }
      load?(): Promise<unknown>
      select?(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<unknown> | unknown
    } | undefined
  }
  readonly uiConversation: {
    readonly events: { register(definition: unknown): void }
    /** View-definition registry (peer activity target). */
    readonly views?: { register(definition: unknown): void }
    /** Per-session binding used to reset the active conversation view. */
    readonly binding?: (sessionId: string) => { readonly activate?: (view: string) => void } | undefined
  }
  readonly slots: {
    inject(name: string, callback: () => void): void
    register(options: unknown, component: unknown): void
  }
  readonly sessions?: {
    open?: (id: SessionId) => void
    readonly binding?: (sessionId: string) => {
      readonly session?: {
        readonly header?: { readonly origin?: string }
        readonly meta?: { readonly origin?: string }
        readonly projections?: { readonly faceOf?: (key: string) => PeerProjectionFace | undefined }
      }
    } | undefined
    readonly list?: {
      readonly getSnapshot?: () => { readonly current?: string }
      readonly subscribe?: (listener: () => void) => () => void
    }
  }
  readonly uiWorkspace?: { openSession?: (id: SessionId) => void }
  readonly [serviceName: string]: unknown
  readonly locale: { register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Required services: conversation nodes, slots, addressed sessions, copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'uiWorkspace', 'modelDirectories', 'remote', 'remote.session']

/**
 * Register the Definition, the transcript card, and the composer dock. Plans
 * are always English: the dictionary registers English for every supported DSH
 * locale and the fallback is English too.
 */
export function apply(ctx: ClientContext): void {
  const client = ctx as unknown as ClientServices
  /**
   * Official typed sessions service (upstream reads it through `ctx.get`);
   * arbitrary proxy fields do not reliably expose every method.
   */
  const sessionsService = (ctx as unknown as { get?: (name: string) => unknown }).get?.('sessions') as ISessions | undefined

  /**
   * Open one ordinary session by id (peer navigation; no subagent path).
   *
   * Session selection left the Session Controller in the 0.1.7 line: its
   * `ISessions.open` is gone and navigation now belongs to the Workspace view
   * owner. `uiWorkspace.openSession` exists on both lines, so it leads; the
   * retired `sessions.open` stays reachable for older hosts and fixtures.
   */
  const openSession = (sessionId: string): void => {
    const workspace = client.uiWorkspace
    if (typeof workspace?.openSession === 'function') {
      workspace.openSession(sessionId as SessionId)
      return
    }
    const legacy = sessionsService as unknown as { open?: (id: SessionId) => void } | undefined
    if (typeof legacy?.open === 'function') {
      legacy.open(sessionId as SessionId)
      return
    }
    const sessions = client.sessions as unknown as { open?: (id: SessionId) => void } | undefined
    if (typeof sessions?.open === 'function') sessions.open(sessionId as SessionId)
  }

  /**
   * Plan source for the current session: its own `endeavourPlan` projection, or
   * the paired Endeavour root's face when the current session is the
   * Challenger. Both peers render the same canonical card data.
   */
  const planSource = (sessionId: string): EndeavourInjected['planSource'] => {
    const own = faceOf(sessionId, 'endeavourPlan')
    const peer = faceOf(sessionId, 'endeavourPeer')?.getSnapshot() as PeerState | null | undefined
    const view = peerView(peer ?? null, sessionId)
    const rootId = view?.role === 'challenger' ? view.counterpartId : undefined
    const rootFace = rootId === undefined ? undefined : faceOf(rootId, 'endeavourPlan')
    const preferred = (own?.getSnapshot() ?? null) === null ? rootFace : own
    const face = preferred ?? own ?? rootFace
    return {
      getSnapshot: () => face?.getSnapshot() ?? null,
      subscribe: (listener: () => void) => face?.subscribe(listener) ?? (() => undefined),
    }
  }

  /**
   * Paired-return observable: `{ counterpartId }` while the session is the
   * CHALLENGER side of a valid pair, null otherwise. Reactive, so the composer
   * fallback appears when the pair arrives and disappears when it is broken.
   */
  const peerReturn = (sessionId: string): EndeavourInjected['peerReturn'] => {
    const face = faceOf(sessionId, 'endeavourPeer')
    // `useSyncExternalStore` requires a STABLE snapshot reference: derive once
    // per raw projection state object instead of building a new value per call.
    const cache = new WeakMap<object, { counterpartId: string } | null>()
    return {
      getSnapshot: () => {
        const state = (face?.getSnapshot() ?? null) as PeerState | null
        if (state === null) return null
        const cached = cache.get(state)
        if (cached !== undefined) return cached
        const view = peerView(state, sessionId)
        const value = view?.role === 'challenger' ? { counterpartId: view.counterpartId } : null
        cache.set(state, value)
        return value
      },
      subscribe: (listener: () => void) => face?.subscribe(listener) ?? (() => undefined),
    }
  }

  const injected = (sessionId?: string): EndeavourInjected => ({
    openCounterpart: (id) => { openSession(id) },
    ...(sessionId === undefined
      ? {}
      : { currentSessionId: sessionId, planSource: planSource(sessionId), peerReturn: peerReturn(sessionId) }),
  })

  /** Official projection face for one session, when its binding exists. */
  const faceOf = (sessionId: string, key: string): PeerProjectionFace | undefined => {
    try {
      const binding = sessionsService?.binding?.(sessionId as SessionId)
        ?? client.sessions?.binding?.(sessionId)
      const face = binding?.session?.projections?.faceOf?.(key)
      return face !== undefined && typeof face.getSnapshot === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }
  const currentSession = (): string | undefined => {
    try {
      return sessionsService?.list?.getSnapshot?.().current ?? client.sessions?.list?.getSnapshot?.().current
    } catch {
      return undefined
    }
  }
  const subscribeCurrent = (listener: () => void): (() => void) => {
    try {
      const subscribe = sessionsService?.list?.subscribe ?? client.sessions?.list?.subscribe
      return typeof subscribe === 'function' ? subscribe(listener) : () => undefined
    } catch {
      return () => undefined
    }
  }
  /**
   * Explicit Builder-tab selection: Chat first (so a return to the root stays
   * Chat), then the SAME addressed bridge the dock's Open Builder uses. No
   * spawn, no settings write, no model call.
   */
  /**
   * The official selector the native tab strip uses (`selectView`): it
   * activates the target AND persists the per-session view preference. The
   * view receives it as the `openView` prop, so this is the same path a tab
   * click takes — no private store poke.
   */
  /**
   * Explicit peer-tab selection: reset the local view to Chat (so a return
   * never re-opens the peer), then open the exact counterpart ordinary session
   * through `openSession`. No spawn, no settings write, no model call, and no
   * subagent address anywhere in the path.
   */
  const selectPeerTab = (sessionId: string, openView?: (view: string, focus: string) => void): boolean => openPeerTab(sessionId, {
    resetChat: () => {
      try {
        openView?.('chat', '')
      } catch {
        // A missing selector must never break the navigation attempt.
      }
    },
    peer: faceOf(sessionId, 'endeavourPeer')?.getSnapshot(),
    openCounterpart: (counterpartId) => {
      openSession(counterpartId)
    },
    transientActivation: hasTransientUserActivation(),
  })


  /**
   * Per-root model bridge. The Endeavour directory supplies inherited selection
   * and catalog reads before a validated peer exists; Challenger writes resolve
   * only the exact peer id named by a valid Endeavour-side checkpoint. Pending
   * choices are browser-local, and controller identity is memoized per root.
   *
   * `directoryFor` FAILS LOUD for a session without a live scope or UI binding,
   * and that condition is transient for a paired peer (it can be alive without
   * being bound yet). The bridge therefore treats exactly those two documented
   * failures as "this role is unavailable right now" and reports them locally;
   * every other error still propagates.
   */
  const unifiedControllers = new Map<string, UnifiedModelController>()
  const unifiedModels = (sessionId: string): UnifiedModelController => {
    const existing = unifiedControllers.get(sessionId)
    if (existing !== undefined) return existing
    // Only a fully validated Endeavour-side checkpoint may name the write target.
    // Once latched, that exact id survives transient projection gaps; no id is
    // derived from a root or guessed when no checkpoint has named a peer.
    let retainedChallengerId: string | undefined
    const peerFace = faceOf(sessionId, 'endeavourPeer')
    const validatedPeer = (): { readonly role: 'endeavour' | 'challenger'; readonly counterpartId: string } | undefined => {
      const state = (peerFace?.getSnapshot() ?? null) as PeerState | null
      if (state === null || validatePeerState(state).length > 0) return undefined
      return peerView(state, sessionId) ?? undefined
    }
    const challengerId = (): string | undefined => {
      const view = validatedPeer()
      if (view?.role === 'endeavour') retainedChallengerId = view.counterpartId
      else if (view?.role === 'challenger') retainedChallengerId = undefined
      return retainedChallengerId
    }
    const isKnownSubagent = (): boolean => {
      try {
        const binding = (sessionsService as unknown as { binding?: (id: SessionId) => unknown } | undefined)?.binding?.(sessionId as SessionId)
          ?? client.sessions?.binding?.(sessionId)
        const session = (binding as { readonly session?: { readonly header?: { readonly origin?: string }; readonly meta?: { readonly origin?: string } } } | undefined)?.session
        return session?.header?.origin === 'subagent' || session?.meta?.origin === 'subagent'
      } catch {
        return false
      }
    }

    let admitted = false
    const sourceListeners = new Set<() => void>()
    let sourceGeneration = 0
    let sourceKey = `hidden:${sessionId}`
    let sourceSnapshotValue: UnifiedModelSourceSnapshot = { mode: 'hidden', key: sourceKey, generation: sourceGeneration }
    const updateSource = (): boolean => {
      const view = validatedPeer()
      if (view?.role === 'endeavour') retainedChallengerId = view.counterpartId
      // A validated Challenger-side checkpoint is evidence that this is not the
      // ordinary Endeavour root, even when a preset projection is present.
      if (view?.role === 'challenger') {
        admitted = false
        retainedChallengerId = undefined
      }
      const peerId = retainedChallengerId
      const mode: UnifiedModelSourceSnapshot['mode'] = !admitted
        ? 'hidden'
        : peerId === undefined ? 'draft' : 'peer'
      const nextKey = mode === 'peer' ? `peer:${peerId}` : `${mode}:${sessionId}`
      if (nextKey === sourceKey) return false
      sourceKey = nextKey
      sourceGeneration += 1
      sourceSnapshotValue = mode === 'peer'
        ? { mode, key: sourceKey, generation: sourceGeneration, peerId: peerId as string }
        : { mode, key: sourceKey, generation: sourceGeneration }
      return true
    }
    const sourceSnapshot = (): UnifiedModelSourceSnapshot => {
      updateSource()
      return sourceSnapshotValue
    }
    const notifySource = (): void => {
      if (updateSource()) for (const listener of [...sourceListeners]) listener()
    }
    const admit = (preset: string | undefined): boolean => {
      const view = validatedPeer()
      if (preset !== undefined && preset !== 'endeavour') {
        admitted = false
        retainedChallengerId = undefined
      } else if (isKnownSubagent() || view?.role === 'challenger') {
        admitted = false
        retainedChallengerId = undefined
      } else if (preset === 'endeavour' && sessionId.trim() !== '') admitted = true
      updateSource()
      return admitted
    }

    const peerDirectory = (id: string): DirectoryLike | undefined => {
      try {
        return client.modelDirectories?.directoryFor?.(id)
      } catch (error) {
        if (isUnavailableSessionError(error)) return undefined
        throw error
      }
    }
    const rootDirectory = (): DirectoryLike | undefined => peerDirectory(sessionId)
    const directory = (target: UnifiedRole): DirectoryLike | undefined => {
      const id = target === 'endeavour' ? sessionId : challengerId()
      return id === undefined ? undefined : peerDirectory(id)
    }
    const unavailable = (target: UnifiedRole): Error => new Error(
      target === 'endeavour' ? 'the Endeavour session is unavailable' : 'the paired Challenger session is unavailable',
    )
    const applyDirectorySelection = async (id: string, selection: UnifiedSelection): Promise<void> => {
      const dir = peerDirectory(id)
      if (dir === undefined) throw new Error(id === sessionId ? 'the Endeavour session is unavailable' : 'the paired Challenger session is unavailable')
      if (typeof dir.select !== 'function') throw new Error('model selection service is unavailable')
      const result = await dir.select({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
      if (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) {
        const detail = 'error' in result ? result.error : undefined
        const message = detail instanceof Error ? detail.message
          : typeof detail === 'string' ? detail
            : typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string' ? detail.message
              : 'model selection was rejected'
        throw new Error(message)
      }
    }

    /** Retain only the already-validated peer, never a guessed session id. */
    const acquireChallenger = (expectedSessionId?: string): UnifiedRoleLease | undefined => {
      const id = challengerId()
      if (id === undefined || (expectedSessionId !== undefined && expectedSessionId !== id)) return undefined
      const retention = (sessionsService ?? client.sessions) as SessionsRetention | undefined
      const retain = retention?.retain
      if (typeof retain !== 'function') return undefined
      const reference = retain.call(retention, id as SessionId, { source: MODEL_MENU_RETENTION_SOURCE })
      let released = false
      return {
        ready: reference.ready,
        release: () => {
          if (released) return
          released = true
          reference.release()
        },
      }
    }

    // The store is opened lazily and released when its final UI subscriber leaves.
    // A remount reads the same browser-local record back from localStorage.
    type PendingStore = ReturnType<typeof createPendingChallengerSelectionStore>
    let pendingStore: PendingStore | undefined
    let pendingSubscribers = 0
    const getPendingStore = (): PendingStore => {
      if (pendingStore !== undefined) return pendingStore
      const storage = {
        getItem: (key: string): string | null => {
          if (typeof window === 'undefined') throw new Error('browser storage unavailable')
          return window.localStorage.getItem(key)
        },
        setItem: (key: string, value: string): void => {
          if (typeof window === 'undefined') throw new Error('browser storage unavailable')
          window.localStorage.setItem(key, value)
        },
        removeItem: (key: string): void => {
          if (typeof window === 'undefined') throw new Error('browser storage unavailable')
          window.localStorage.removeItem(key)
        },
      }
      const origin = typeof window === 'undefined' ? 'unavailable-origin' : window.location.origin
      const eventTarget = typeof window === 'undefined' ? undefined : (() => {
        const wrappers = new Map<(event: { readonly key: string | null; readonly newValue: string | null }) => void, (event: StorageEvent) => void>()
        return {
          addEventListener: (_type: 'storage', listener: (event: { readonly key: string | null; readonly newValue: string | null }) => void): void => {
            const wrapper = (event: StorageEvent): void => listener({ key: event.key, newValue: event.newValue })
            wrappers.set(listener, wrapper)
            window.addEventListener('storage', wrapper)
          },
          removeEventListener: (_type: 'storage', listener: (event: { readonly key: string | null; readonly newValue: string | null }) => void): void => {
            const wrapper = wrappers.get(listener)
            if (wrapper === undefined) return
            wrappers.delete(listener)
            window.removeEventListener('storage', wrapper)
          },
        }
      })()
      pendingStore = createPendingChallengerSelectionStore({ storage, lockProvider: browserSelectionLockProvider, origin, rootSessionId: sessionId, ...(eventTarget === undefined ? {} : { eventTarget }) })
      return pendingStore
    }
    const emptyPendingSnapshot: PendingChallengerSelectionSnapshot = Object.freeze({})
    const pendingSelection = {
      // Render reads only an already-loaded snapshot; storage is opened after
      // commit by subscribe, or by an explicit selection action.
      getSnapshot: () => sourceSnapshot().mode === 'hidden' ? emptyPendingSnapshot : pendingStore?.getSnapshot() ?? emptyPendingSnapshot,
      subscribe: (listener: () => void): (() => void) => {
        if (sourceSnapshot().mode === 'hidden') return () => undefined
        const owner = getPendingStore()
        const unsubscribe = owner.subscribe(listener)
        pendingSubscribers += 1
        let active = true
        return () => {
          if (!active) return
          active = false
          unsubscribe()
          pendingSubscribers -= 1
          if (pendingSubscribers === 0 && pendingStore === owner) {
            owner.dispose()
            pendingStore = undefined
          }
        }
      },
      save: (selection: UnifiedSelection) => getPendingStore().save(selection),
      removeIfRevision: (revision: string) => getPendingStore().removeIfRevision(revision),
    }

    let applyChain: Promise<void> = Promise.resolve()
    const applyPendingToPeer = (revision: string, peerId: string, generation: number): Promise<boolean> => {
      const task = applyChain.then(async () => {
        const source = sourceSnapshot()
        if (source.mode !== 'peer' || source.peerId !== peerId || source.generation !== generation) return false
        const record = pendingSelection.getSnapshot().record
        if (record === undefined || record.revision !== revision) return false
        await applyDirectorySelection(peerId, record)
        const after = sourceSnapshot()
        const current = pendingSelection.getSnapshot().record
        if (after.mode !== 'peer' || after.peerId !== peerId || after.generation !== generation || current?.revision !== revision) return false
        return await pendingSelection.removeIfRevision(revision)
      })
      applyChain = task.then(() => undefined, () => undefined)
      return task
    }

    const roleController = (target: UnifiedRole): UnifiedRoleController => ({
      available: () => directory(target) !== undefined,
      readSelection: (): UnifiedSelection | undefined => {
        const current = directory(target)?.store?.getSnapshot?.().current
        if (current === null || current === undefined) return undefined
        const { provider, model, reasoningEffort } = current
        if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
        return typeof reasoningEffort === 'string' && reasoningEffort !== '' ? { provider, model, reasoningEffort } : { provider, model }
      },
      subscribeSelection: (listener) => {
        const store = directory(target)?.store
        if (store === undefined || typeof store.subscribe !== 'function') return () => undefined
        try { return store.subscribe(listener) } catch (error) {
          if (isUnavailableSessionError(error)) return () => undefined
          throw error
        }
      },
      loadCatalog: async () => {
        // The root's own already-mounted directory is read-only fallback when no
        // validated peer exists. It is never the target of Challenger writes.
        const dir = target === 'challenger' && sourceSnapshot().mode === 'draft' ? rootDirectory() : directory(target)
        if (dir === undefined) throw unavailable(target)
        return dir.load?.()
      },
      select: async (provider, model, reasoningEffort) => {
        const id = target === 'endeavour' ? sessionId : challengerId()
        if (id === undefined) throw unavailable(target)
        await applyDirectorySelection(id, { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
      },
      ...(target === 'challenger' ? { acquire: acquireChallenger } : {}),
    })
    const controller: UnifiedModelController = {
      roles: { endeavour: roleController('endeavour'), challenger: roleController('challenger') },
      sourceSnapshot,
      subscribeSource: (listener) => {
        sourceListeners.add(listener)
        const disposePeer = peerFace?.subscribe(notifySource) ?? (() => undefined)
        return () => {
          disposePeer()
          sourceListeners.delete(listener)
        }
      },
      pendingSelection,
      applyPendingToPeer,
      admit,
    }
    unifiedControllers.set(sessionId, controller)
    return controller
  }

  client.uiConversation.events.register(endeavourPlanDefinition)
  // Peer activity: the durable `endeavour/peer` checkpoint is legitimate
  // Conversation content, so both halves of a pair leave the blank Hero and
  // render the native header + View strip without any synthetic turn.
  client.uiConversation.events.register(endeavourPeerNodeDefinition)
  client.uiConversation.views?.register(endeavourPeerViewDefinition)
  client.effect(() => reconcilePeerActivity({
    currentSession,
    subscribeCurrent,
    peerFace: faceOf,
    activate: (sessionId) => {
      const binding = client.uiConversation.binding?.(sessionId)
      // The target OWNS a registered view definition, so activation publishes
      // the conversation snapshot (unlike an unregistered target).
      binding?.activate?.(PEER_ACTIVITY_TARGET)
    },
  }), 'dsh-endeavour: peer activity')
  client.effect(() => ensurePlanStyles(), 'dsh-endeavour: plan styles')
  client.effect(() => client.locale.register(NS, { zh: en, en }), 'dsh-endeavour: dictionaries')
  client.slots.inject('conversation.chat.node', () => client.slots.register({
    name: 'conversation.chat.node',
    key: 'endeavour-plan',
    locale: NS,
    inject: injected,
  }, PlanCard as unknown as (props: PlanCardProps) => unknown))
  registerPlanDock(client.slots, injected)
  // The Challenger selector renders in the composer's trailing controls, which
  // is the row immediately left of the host's own model seat. The model seat
  // itself is single-occupancy and DSH's Endeavour selector owns it: a second
  // registration at the same priority is rejected, which used to fail this
  // plugin's whole client activation. Nothing here replaces, unregisters or
  // restyles the native entry.
  client.slots.inject(CHALLENGER_MODEL_SEAT, () => client.slots.register({
    name: CHALLENGER_MODEL_SEAT,
    id: 'endeavour-challenger-model',
    order: 1000,
    locale: NS,
    inject: (sessionId: string) => ({ unifiedModels: unifiedModels(sessionId) }),
  }, ChallengerModelControl as unknown as (props: unknown) => unknown))
  // Builder navigation tab: registered only while the current session is an
  // Builder/Challenger tab: registered only while the current session belongs
  // to a valid durable pair; order 20 places it right after Trajectory.
  client.slots.inject('conversation.view', () => {
    client.effect(() => reconcilePeerTab({
      currentSession,
      subscribeCurrent,
      peerFace: faceOf,
      register: (role) => registerPeerTabEntry(
        client.slots as unknown as { inject(name: string, callback: () => void): void; register(options: never, component: unknown): () => void },
        role,
        selectPeerTab,
      ),
    }), 'dsh-endeavour: peer navigation tab')
  })
}
