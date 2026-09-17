/**
 * Composer plan dock: the same durable plan, rendered natively directly above
 * the composer through the `conversation.input.dock` list slot.
 *
 * The dock selects the latest `endeavour-plan` Chat node from the current Chat
 * snapshot, so it renders only where such a node exists — an Endeavour
 * root-session chat. Standard and Builder chats have no such node and render
 * nothing. No second state stream is created.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { EndeavourCardData } from './definition.js'
import { NS, type EndeavourKey } from './locales.js'
import { copyFrom, type EndeavourInjected } from './PlanCard.js'
import { PlanView } from './PlanView.js'

/** Complete dock renderer props (session scope supplies `useChat`). */
export type PlanDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

/** Latest durable plan node in Chat order, or undefined when none exists. */
export function latestPlanNode(nodes: readonly ChatConversationViewNode[]): ChatConversationViewNode | undefined {
  let found: ChatConversationViewNode | undefined
  for (const node of nodes) {
    if (node.kind === 'endeavour-plan') found = node
  }
  return found
}

/** Selector over the Chat snapshot used by the dock. */
export function selectPlanNode(snapshot: { readonly nodes: { values(): readonly ChatConversationViewNode[] } }): ChatConversationViewNode | undefined {
  return latestPlanNode(snapshot.nodes.values())
}

/** Dock body; renders nothing without a plan node. */
export function PlanDock(props: PlanDockProps): React.ReactElement | null {
  const node = props.useChat(selectPlanNode)
  if (node === undefined) return null
  const data = node.data as EndeavourCardData
  return (
    <PlanView
      data={data}
      copy={copyFrom(props)}
      onOpenBuilder={() => { props.openSession(data.childId as SessionId) }}
      variant="dock"
    />
  )
}

/** Stable dock id and order (before the built-in todo dock at order 0). */
export const PLAN_DOCK_ID = 'endeavour-plan'
export const PLAN_DOCK_ORDER = -1

/** Registers the composer plan dock. */
export function registerPlanDock(ctx: ClientContext, slots: {
  inject(name: string, callback: () => void): void
  register(options: { name: string; id: string; order: number; locale: string }, component: unknown): void
}): void {
  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: PLAN_DOCK_ID, order: PLAN_DOCK_ORDER, locale: NS },
    PlanDock as unknown as (props: PlanDockProps) => unknown,
  ))
}

/** Copy helper re-exported for tests. */
export type { EndeavourKey }
