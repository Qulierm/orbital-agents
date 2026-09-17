/** Keyed transcript renderer for the durable Endeavour plan card. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { EndeavourCardData } from './definition.js'
import { formatEnglish, type EndeavourKey } from './locales.js'
import { PlanView } from './PlanView.js'

/** Navigation injected from the plugin's own Session Controller access. */
export interface EndeavourInjected {
  readonly openSession: (id: SessionId) => void
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

/** One plan card in the transcript; shares its presentation with the dock. */
export function PlanCard(props: PlanCardProps): React.ReactElement | null {
  const node = (props as { readonly node?: ChatConversationViewNode }).node
  const data = node?.data as EndeavourCardData | undefined
  if (data === undefined) return null
  return (
    <PlanView
      data={data}
      copy={copyFrom(props)}
      onOpenBuilder={() => { props.openSession(data.childId as SessionId) }}
      variant="card"
    />
  )
}
