/** Keyed transcript renderer for the durable Endeavour plan card. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type { EndeavourCardData } from '../plan-projection.js'
import { formatEnglish, type EndeavourKey } from './locales.js'
import { PlanView } from './PlanView.js'

/** Addressed continuation navigation injected from the plugin's own services. */
export interface EndeavourInjected {
  readonly openBuilder: (address: SubagentAddress) => void
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
 * Exact continuable address for the plan's Builder child. Returns undefined for
 * malformed data so navigation is a no-op instead of opening a wrong session.
 */
export function builderAddress(data: EndeavourCardData): SubagentAddress | undefined {
  if (typeof data.rootSessionId !== 'string' || data.rootSessionId === '') return undefined
  if (typeof data.childId !== 'string' || data.childId === '') return undefined
  return { parentSessionId: data.rootSessionId as never, childSessionId: data.childId as never, mode: 'continuable' }
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
        const address = builderAddress(data)
        if (address !== undefined) props.openBuilder(address)
      }}
      variant="card"
    />
  )
}
