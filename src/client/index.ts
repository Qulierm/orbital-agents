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
import { en, NS, type EndeavourKey } from './locales.js'
import { ensurePlanStyles } from './styles.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Endeavour plan copy (English only, all locales). */
    endeavour: EndeavourKey
  }
}

/** Narrow view of the client services this plugin consumes. */
interface ClientServices {
  readonly uiConversation: { readonly events: { register(definition: unknown): void } }
  readonly slots: {
    inject(name: string, callback: () => void): void
    register(options: unknown, component: unknown): void
  }
  readonly sessions?: {
    openSubagent?: (address: SubagentAddress) => void
    open?: (id: SessionId) => void
  }
  readonly uiWorkspace?: { openSession?: (id: SessionId) => void }
  readonly locale: { register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Required services: conversation nodes, slots, addressed sessions, copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale', 'uiWorkspace']

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
}
