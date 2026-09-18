/** Keyed transcript renderer for the durable Endeavour plan card. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { EndeavourCardData } from '../plan-projection.js'
import { formatEnglish, type EndeavourKey } from './locales.js'
import { PlanView } from './PlanView.js'

/** Peer navigation injected from the plugin's own services. */
export interface EndeavourInjected {
  /** Open the plan's executor session (the persistent Challenger). */
  readonly openCounterpart: (sessionId: string) => void
  /**
   * Official cross-session plan source: the current session's projection, or
   * the paired Endeavour root's when the current session is the Challenger.
   */
  readonly planSource?: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  } | undefined
}

/** Complete keyed Chat renderer props. */
export type PlanCardProps =
  PropsRuntime<'conversation.chat.node', 'endeavour-plan'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

export { formatElapsed, taskElapsed } from './PlanView.js'

/** Build a copy function from the locale seat, falling back to English copy. */
export function copyFrom(props: { readonly t?: unknown }): (key: EndeavourKey, params?: Record<string, string | number>) => string {
  return (key, params) => {
    const seat = props.t as ((key: string, params?: Record<string, unknown>) => string | undefined) | undefined
    const value = typeof seat === 'function' ? seat(key, params) : undefined
    return value ?? formatEnglish(key, params)
  }
}

/**
 * Executor session id for the plan: the persistent Challenger for peer plans,
 * or the legacy child id for historical cards. Returns undefined for malformed
 * data so navigation is a no-op instead of opening a wrong session.
 */
export function cardExecutorId(data: EndeavourCardData): string | undefined {
  if (typeof data.rootSessionId !== 'string' || data.rootSessionId === '') return undefined
  const executor = typeof data.challengerSessionId === 'string' && data.challengerSessionId !== ''
    ? data.challengerSessionId
    : data.childId
  return typeof executor === 'string' && executor !== '' ? executor : undefined
}

/** One plan card in the transcript; shares its presentation with the dock. */
export function PlanCard(props: PlanCardProps): React.ReactElement | null {
  const node = (props as { readonly node?: ChatConversationViewNode }).node
  const data = node?.data as EndeavourCardData | undefined
  if (data === undefined) return null
  return (
    <PlanView
      data={data}
      copy={copyFrom(props)}
      onOpenBuilder={() => {
        const executor = cardExecutorId(data)
        if (executor !== undefined) props.openCounterpart(executor)
      }}
      variant="card"
    />
  )
}
