/** Browser plugin entry: register the plan definition, copy, and keyed renderer. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { endeavourPlanDefinition } from './definition.js'
import { PlanCard, type EndeavourInjected, type PlanCardProps } from './PlanCard.js'
import { en, NS, ru, type EndeavourKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Endeavour plan-card copy. */
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
  readonly sessions: { open(id: SessionId): void }
  readonly locale: { register(ns: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void }
  effect(callback: () => (() => void) | void, label?: string): void
}

/** Required services for the Definition, keyed renderer, and copy. */
export const inject = ['uiConversation', 'slots', 'sessions', 'locale']

/**
 * Register the Definition, dictionary, and keyed Chat renderer. The v0.1.5
 * locale surface accepts only `zh`/`en`, so the exact Russian status phrases
 * are rendered from the plugin's own copy while the service dictionary backs
 * the remaining labels.
 */
export function apply(ctx: ClientContext): void {
  const client = ctx as unknown as ClientServices
  client.uiConversation.events.register(endeavourPlanDefinition)
  client.effect(() => client.locale.register(NS, { zh: en, en }), 'dsh-endeavour: dictionaries')
  client.slots.inject('conversation.chat.node', () => client.slots.register({
    name: 'conversation.chat.node',
    key: 'endeavour-plan',
    locale: NS,
    inject: (): EndeavourInjected => ({
      openSession: (id: SessionId) => { client.sessions.open(id) },
    }),
  }, PlanCard as unknown as (props: PlanCardProps) => unknown))
  void ru
}
