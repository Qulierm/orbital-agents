/** Browser plugin entry: plan definition, English copy, transcript card, dock. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
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
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BuilderRouteControl, type BuilderRouteController } from './BuilderRouteControl.js'
import { BUILDER_SETTINGS_NAMESPACE, type BuilderRouteSettings } from '../builder-settings-shared.js'
import { en, NS, type EndeavourKey } from './locales.js'
import { ensurePlanStyles } from './styles.js'
import {
  openBuilderTab,
  reconcileBuilderTab,
  registerBuilderTabEntry,
  type ProjectionFace,
} from './builder-tab.js'

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
    openSubagent?: (address: SubagentAddress) => void
    open?: (id: SessionId) => void
    readonly binding?: (sessionId: string) => {
      readonly session?: {
        readonly projections?: { readonly faceOf?: (key: string) => ProjectionFace | undefined }
      }
    } | undefined
    readonly list?: {
      readonly getSnapshot?: () => { readonly current?: string }
      readonly subscribe?: (listener: () => void) => () => void
    }
  }
  readonly uiWorkspace?: { openSession?: (id: SessionId) => void }
  readonly settingsScope?: {
    bind<T>(spec: { namespace: string }): {
      getSnapshot(): { readonly value: T | undefined }
      set(field: string, value: unknown): Promise<void>
      unset(field: string): Promise<void>
    }
  }
  readonly remote?: { readonly session?: { modelCatalog(): Promise<unknown> } }
  readonly [serviceName: string]: unknown
  readonly locale: { register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Required services: conversation nodes, slots, addressed sessions, copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'uiWorkspace', 'settingsScope', 'remote', 'remote.session']

/**
 * Register the Definition, the transcript card, and the composer dock. Plans
 * are always English: the dictionary registers English for every supported DSH
 * locale and the fallback is English too.
 */
export function apply(ctx: ClientContext): void {
  const client = ctx as unknown as ClientServices

  /** Native addressed-subagent navigation, with a workspace fallback. */
  const openBuilder = (address: SubagentAddress): void => {
    const sessions = client.sessions
    if (typeof sessions?.openSubagent === 'function') {
      sessions.openSubagent(address)
      return
    }
    if (typeof client.uiWorkspace?.openSession === 'function') {
      client.uiWorkspace.openSession(address.childSessionId)
      return
    }
    if (typeof sessions?.open === 'function') sessions.open(address.childSessionId)
  }
  const injected = (): EndeavourInjected => ({ openBuilder })

  /** Official projection face for one session, when its binding exists. */
  const faceOf = (sessionId: string, key: string): ProjectionFace | undefined => {
    try {
      const face = client.sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.(key)
      return face !== undefined && typeof face.getSnapshot === 'function' ? face : undefined
    } catch {
      return undefined
    }
  }
  const currentSession = (): string | undefined => {
    try {
      return client.sessions?.list?.getSnapshot?.().current
    } catch {
      return undefined
    }
  }
  const subscribeCurrent = (listener: () => void): (() => void) => {
    try {
      const subscribe = client.sessions?.list?.subscribe
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
  const selectBuilderTab = (sessionId: string): boolean => openBuilderTab(sessionId, {
    activateChat: (id) => {
      try {
        client.uiConversation.binding?.(id)?.activate?.('chat')
      } catch {
        // The view store is already unavailable; a missing reset must not throw.
      }
    },
    readPlan: (id) => faceOf(id, 'endeavourPlan')?.getSnapshot(),
    open: (target) => openBuilder({
      parentSessionId: target.parentSessionId as SessionId,
      childSessionId: target.childSessionId as SessionId,
      mode: 'continuable',
    }),
  })

  /** Settings bridge for the Builder route control. */
  const scope = client.settingsScope?.bind<BuilderRouteSettings>({ namespace: BUILDER_SETTINGS_NAMESPACE })
  const readSettings = (): BuilderRouteSettings => {
    const value = scope?.getSnapshot().value
    return value === undefined ? { mode: 'inherit' } : { ...value }
  }
  const writeSettings = async (next: BuilderRouteSettings): Promise<void> => {
    if (scope === undefined) throw new Error('Builder route settings are unavailable in this deployment')
    await scope.set('mode', next.mode)
    if (next.mode === 'custom' && next.provider !== undefined && next.model !== undefined) {
      await scope.set('provider', next.provider)
      await scope.set('model', next.model)
      if (next.reasoningEffort === undefined) await scope.unset('reasoningEffort')
      else await scope.set('reasoningEffort', next.reasoningEffort)
    } else {
      await scope.unset('provider')
      await scope.unset('model')
      await scope.unset('reasoningEffort')
    }
    if (next.maxTokens === undefined) await scope.unset('maxTokens')
    else await scope.set('maxTokens', next.maxTokens)
  }
  const loadCatalog = async (): Promise<ModelCatalog> => {
    // The controller is reachable as ctx.remote.session; some deployments keep
    // the dotted service name directly, so both access paths are tried.
    const dotted = (client as { 'remote.session'?: { modelCatalog?: () => Promise<unknown> } })['remote.session']
    const session = client.remote?.session ?? (typeof dotted?.modelCatalog === 'function' ? dotted : undefined)
    if (session === undefined || typeof session.modelCatalog !== 'function') {
      throw new Error('model catalog is unavailable')
    }
    const raw = await session.modelCatalog() as { ok?: boolean; value?: ModelCatalog; error?: unknown; type?: string } | ModelCatalog
    if ((raw as { ok?: boolean }).ok === false) {
      throw new Error(String((raw as { error?: unknown }).error ?? 'model catalog failed'))
    }
    const unwrapped = (raw as { value?: ModelCatalog }).value ?? raw
    const catalog = ((unwrapped as { value?: ModelCatalog }).value ?? unwrapped) as ModelCatalog
    if (!Array.isArray(catalog.groups)) throw new Error('model catalog response had no groups')
    return catalog
  }
  const builderRoute: BuilderRouteController = { readSettings, writeSettings, loadCatalog }

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
    id: 'endeavour-builder',
    order: 1000,
    locale: NS,
    inject: () => ({ builderRoute }),
  }, BuilderRouteControl as unknown as (props: unknown) => unknown))
  client.slots.inject('conversation.input.right', () => client.slots.register({
    name: 'conversation.input.right',
    id: 'endeavour-role',
    order: 1001,
    locale: NS,
  }, EndeavourRoleLabel as unknown as (props: unknown) => unknown))
  // Builder navigation tab: registered only while the current session is an
  // Endeavour root with a valid durable child address; order 20 places it right
  // after Trajectory (native order 10) and before nothing else in the strip.
  client.slots.inject('conversation.view', () => {
    client.effect(() => reconcileBuilderTab({
      currentSession,
      subscribeCurrent,
      face: faceOf,
      register: () => registerBuilderTabEntry(
        client.slots as unknown as { inject(name: string, callback: () => void): void; register(options: never, component: unknown): () => void },
        selectBuilderTab,
      ),
    }), 'dsh-endeavour: Builder navigation tab')
  })
}
