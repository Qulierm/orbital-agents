/** Browser plugin entry: plan definition, English copy, transcript card, dock. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { endeavourPlanDefinition } from './definition.js'
import { PlanCard, type EndeavourInjected, type PlanCardProps } from './PlanCard.js'
import { registerPlanDock } from './PlanDock.js'
import { EndeavourRoleLabel } from './EndeavourRoleLabel.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ChallengerModelControl, type ChallengerModelController, type ChallengerSelection } from './ChallengerModelControl.js'
import { en, NS, type EndeavourKey } from './locales.js'
import { ensurePlanStyles } from './styles.js'
import { peerView } from '../peer-projection.js'
import type { PeerState } from '../peer.js'
import {
  hasTransientUserActivation,
  openPeerTab,
  peerTabTarget,
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
  readonly uiConversation: {
    readonly events: { register(definition: unknown): void }
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
  readonly remote?: { readonly session?: { modelCatalog(): Promise<unknown> } }
  readonly [serviceName: string]: unknown
  readonly locale: { register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Required services: conversation nodes, slots, addressed sessions, copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'uiWorkspace', 'remote', 'remote.session']

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

  const injected = (sessionId?: string): EndeavourInjected => ({
    openCounterpart: (id) => { openSession(id) },
    ...(sessionId === undefined ? {} : { planSource: planSource(sessionId) }),
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

  /** Live model catalog (no model request; the controller owns caching). */
  const loadCatalog = async (): Promise<ModelCatalog> => {
    const dotted = (client as { 'remote.session'?: { modelCatalog?: () => Promise<unknown> } })['remote.session']
    const session = client.remote?.session ?? (typeof dotted?.modelCatalog === 'function' ? dotted : undefined)
    if (session === undefined || typeof session.modelCatalog !== 'function') {
      throw new Error('model catalog is unavailable')
    }
    const raw = await session.modelCatalog() as { ok?: boolean; value?: ModelCatalog; error?: unknown } | ModelCatalog
    if ((raw as { ok?: boolean }).ok === false) throw new Error(String((raw as { error?: unknown }).error ?? 'model catalog failed'))
    const unwrapped = ((raw as { value?: ModelCatalog }).value ?? raw) as { value?: ModelCatalog }
    const catalog = (unwrapped.value ?? unwrapped) as ModelCatalog
    if (!Array.isArray(catalog.groups)) throw new Error('model catalog response had no groups')
    return catalog
  }

  /**
   * Peer model bridge: the paired Challenger owns its ordinary-session model
   * selection. The root control only mirrors it (projection face) and writes
   * through the official remote.selectModel for the CHALLENGER session; the
   * Endeavour route is never touched and the session is never recreated.
   */
  const challengerModel = (sessionId: string): ChallengerModelController => {
    const challengerId = (): string | undefined => {
      const peer = faceOf(sessionId, 'endeavourPeer')?.getSnapshot() as PeerState | null | undefined
      const view = peerView(peer ?? null, sessionId)
      return view?.role === 'endeavour' ? view.counterpartId : undefined
    }
    const selectionFace = () => {
      const id = challengerId()
      return id === undefined ? undefined : faceOf(id, 'modelSelection')
    }
    return {
      challengerId,
      readSelection: () => {
        const value = selectionFace()?.getSnapshot() as { current?: ChallengerSelection; next?: ChallengerSelection } | undefined
        return value?.next ?? value?.current
      },
      subscribeSelection: (listener) => selectionFace()?.subscribe(listener) ?? (() => undefined),
      loadCatalog,
      select: async (provider, model, reasoningEffort) => {
        const id = challengerId()
        if (id === undefined) throw new Error('the paired Challenger session is unavailable')
        const remote = (client as unknown as { remote?: { session?: { selectModel?: (request: unknown) => Promise<unknown> } } }).remote?.session
          ?? (client as unknown as { 'remote.session'?: { selectModel?: (request: unknown) => Promise<unknown> } })['remote.session']
        if (typeof remote?.selectModel !== 'function') throw new Error('model selection is unavailable in this deployment')
        await remote.selectModel({
          sessionId: id,
          provider,
          model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        })
      },
    }
  }

  client.uiConversation.events.register(endeavourPlanDefinition)
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
      // Official, event-free activation: the blank Challenger session shows its
      // native header and View ring (Chat/Trajectory/Endeavour) instead of the
      // empty hero, so the reciprocal tab is reachable immediately.
      activateConversation: (sessionId) => {
        const binding = client.uiConversation.binding?.(sessionId)
        binding?.activate?.('chat')
      },
    }), 'dsh-endeavour: peer navigation tab')
  })
}
