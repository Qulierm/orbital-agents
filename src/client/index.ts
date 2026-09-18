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
import { EndeavourRoleLabel } from './EndeavourRoleLabel.js'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ChallengerModelControl, type ChallengerModelController, type ChallengerSelection } from './ChallengerModelControl.js'

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
   * Peer model bridge: the paired Challenger owns its ordinary-session model
   * selection. The root control only mirrors it (projection face) and writes
   * through the official remote.selectModel for the CHALLENGER session; the
   * Endeavour route is never touched and the session is never recreated.
   */
  /**
   * Per-session controller over the OFFICIAL ModelDirectory (`modelDirectories`)
   * the native ModelSelect uses. Loading, current-selection resolution (durable
   * projection, then Host default) and writing all go through that directory, so
   * the Challenger control behaves exactly like a native selector on the
   * Challenger session. Identity is memoized per counterpart id so renders and
   * HMR never swap the store out from under the component.
   */
  const challengerControllers = new Map<string, ChallengerModelController>()
  const challengerModel = (sessionId: string): ChallengerModelController => {
    const challengerId = (): string | undefined => {
      const peer = faceOf(sessionId, 'endeavourPeer')?.getSnapshot() as PeerState | null | undefined
      const view = peerView(peer ?? null, sessionId)
      return view?.role === 'endeavour' ? view.counterpartId : undefined
    }
    const directory = (): DirectoryLike | undefined => {
      const id = challengerId()
      if (id === undefined) return undefined
      const resolver = client.modelDirectories
      return resolver?.directoryFor?.(id)
    }
    const readSelection = (): ChallengerSelection | undefined => {
      const current = directory()?.store?.getSnapshot?.().current
      if (current === null || current === undefined) return undefined
      const { provider, model, reasoningEffort } = current
      if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined
      return typeof reasoningEffort === 'string' && reasoningEffort !== ''
        ? { provider, model, reasoningEffort }
        : { provider, model }
    }
    // One stable controller per session: every closure below resolves the
    // CURRENT directory lazily, so HMR and re-renders keep the same identity
    // without ever pointing at a stale store.
    const existing = challengerControllers.get(sessionId)
    if (existing !== undefined) return existing
    const controller: ChallengerModelController = {
      challengerId,
      readSelection,
      subscribeSelection: (listener) => directory()?.store?.subscribe?.(listener) ?? (() => undefined),
      loadCatalog: async () => {
        const target = directory()
        if (target === undefined) throw new Error('the paired Challenger session is unavailable')
        return target.load?.()
      },
      select: async (provider, model, reasoningEffort) => {
        const target = directory()
        if (target === undefined) throw new Error('the paired Challenger session is unavailable')
        await target.select?.({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
      },
    }
    challengerControllers.set(sessionId, controller)
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
  // The composer toolbar keeps both role groups together on the trailing side:
  // Speed (openai-codex-fast-mode, order 10) and limits (openai-codex-quota,
  // order 20) stay ahead, then the Builder group (1000) and the Endeavour role
  // label (1001); the native conversation.input.model seat renders after the
  // whole right list, so the visual order is
  // ... Speed -> limits -> [Builder | route] -> [Endeavour | native model] -> Send.
  client.slots.inject('conversation.input.right', () => client.slots.register({
    name: 'conversation.input.right',
    id: 'endeavour-challenger-model',
    order: 1000,
    locale: NS,
    inject: (sessionId: string) => ({ challengerModel: challengerModel(sessionId) }),
  }, ChallengerModelControl as unknown as (props: unknown) => unknown))
  client.slots.inject('conversation.input.right', () => client.slots.register({
    name: 'conversation.input.right',
    id: 'endeavour-role',
    order: 1001,
    locale: NS,
  }, EndeavourRoleLabel as unknown as (props: unknown) => unknown))
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
