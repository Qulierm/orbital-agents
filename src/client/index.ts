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
  UnifiedModelControl,
  type UnifiedModelController,
  type UnifiedRole,
  type UnifiedRoleController,
  type UnifiedSelection,
} from './UnifiedModelControl.js'

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

/** Structural view of the official ModelDirectory the native selector uses. */
interface DirectoryLike {
  readonly store?: {
    getSnapshot?(): {
      readonly current?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } | null
    }
    subscribe?(listener: () => void): () => void
  }
  load?(): Promise<unknown>
  select?(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
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
      select?(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
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

  /** Open one ordinary session by id (peer navigation; no subagent path). */
  const openSession = (sessionId: string): void => {
    if (sessionsService !== undefined) {
      sessionsService.open(sessionId as SessionId)
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
   * through the official ISessions.open. No spawn, no settings write, no model
   * call, and no subagent address anywhere in the path.
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
      if (sessionsService !== undefined) {
        sessionsService.open(counterpartId as SessionId)
        return
      }
      const sessions = client.sessions as unknown as { open?: (id: SessionId) => void } | undefined
      if (typeof sessions?.open === 'function') sessions.open(counterpartId as SessionId)
    },
    transientActivation: hasTransientUserActivation(),
  })


  /**
   * Unified model bridge: ONE controller over the official ModelDirectory each
   * ordinary session of the pair owns — the Endeavour session this control is
   * rendered in, and its paired Challenger. Every read, subscription, catalog
   * load and write resolves its own `modelDirectories.directoryFor(id)`, so the
   * two roles never share mutable selection state, no catalog is mutated, and
   * no peer session is created or recreated. Identity is memoized per Endeavour
   * session so renders and HMR never swap the stores out from under the
   * component.
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
    // The paired Challenger id is RETAINED once a validated Endeavour-side
    // projection has named it. The projection can publish null, a half-written
    // snapshot or a forged one at any time (the composer re-renders on its own
    // state), and re-resolving the target on every directory operation would
    // drop the peer mid-interaction. Only fully validated data for THIS root may
    // set or refresh the id — never an arbitrary fallback session.
    let retainedChallengerId: string | undefined
    const challengerId = (): string | undefined => {
      const peer = faceOf(sessionId, 'endeavourPeer')?.getSnapshot() as PeerState | null | undefined
      const candidate = peer ?? null
      if (candidate !== null && validatePeerState(candidate).length === 0) {
        const view = peerView(candidate, sessionId)
        // A validated snapshot for the OTHER side (or another root) is ignored.
        if (view?.role === 'endeavour') retainedChallengerId = view.counterpartId
      }
      return retainedChallengerId
    }
    // The Endeavour side is the session this control belongs to; the Challenger
    // side is its durable companion. Neither id is ever shared between roles.
    const targetId = (target: UnifiedRole): string | undefined => target === 'endeavour' ? sessionId : challengerId()
    const directory = (target: UnifiedRole): DirectoryLike | undefined => {
      const id = targetId(target)
      if (id === undefined) return undefined
      try {
        return client.modelDirectories?.directoryFor?.(id)
      } catch (error) {
        if (isUnavailableSessionError(error)) return undefined
        throw error
      }
    }
    const unavailable = (target: UnifiedRole): Error => new Error(
      target === 'endeavour'
        ? 'the Endeavour session is unavailable'
        : 'the paired Challenger session is unavailable',
    )
    const roleController = (target: UnifiedRole): UnifiedRoleController => ({
      available: () => directory(target) !== undefined,
      readSelection: (): UnifiedSelection | undefined => {
        // A selection read must never throw at render time: the directory is
        // simply absent while its session has no scope or binding.
        const current = directory(target)?.store?.getSnapshot?.().current
        if (current === null || current === undefined) return undefined
        const { provider, model, reasoningEffort } = current
        if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
        return typeof reasoningEffort === 'string' && reasoningEffort !== ''
          ? { provider, model, reasoningEffort }
          : { provider, model }
      },
      subscribeSelection: (listener) => {
        const store = directory(target)?.store
        if (store === undefined || typeof store.subscribe !== 'function') return () => undefined
        try {
          return store.subscribe(listener)
        } catch (error) {
          if (isUnavailableSessionError(error)) return () => undefined
          throw error
        }
      },
      loadCatalog: async () => {
        const dir = directory(target)
        if (dir === undefined) throw unavailable(target)
        return dir.load?.()
      },
      select: async (provider, model, reasoningEffort) => {
        const dir = directory(target)
        if (dir === undefined) throw unavailable(target)
        await dir.select?.({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
      },
    })
    const controller: UnifiedModelController = {
      roles: { endeavour: roleController('endeavour'), challenger: roleController('challenger') },
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
  // The composer keeps exactly ONE model control: an icon-only sliders button
  // that configures both ordinary sessions of the pair. Speed (10) and limits
  // (20) stay ahead of it, and the host-owned native conversation.input.model
  // seat is hidden by CSS only while this control is rendered.
  client.slots.inject('conversation.input.right', () => client.slots.register({
    name: 'conversation.input.right',
    id: 'endeavour-models',
    order: 1000,
    locale: NS,
    inject: (sessionId: string) => ({ unifiedModels: unifiedModels(sessionId) }),
  }, UnifiedModelControl as unknown as (props: unknown) => unknown))
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
