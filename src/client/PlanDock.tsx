/**
 * Composer plan dock: the current durable plan, rendered natively directly
 * above the composer through the `conversation.input.dock` list slot.
 *
 * The dock reads the host `endeavourPlan` session projection — the latest
 * whole card folded over the full session replay — so it shows the current
 * plan even when its events are older than the client's paged transcript
 * window. Standard and Builder chats have no such projection value and render
 * nothing. The transcript ConversationNode stays event-based.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { EndeavourCardData } from '../plan-projection.js'
import { NS, type EndeavourKey } from './locales.js'
import { copyFrom, type EndeavourInjected } from './PlanCard.js'
import { PlanView } from './PlanView.js'

/** Complete dock renderer props (session scope supplies `useProjection`). */
export type PlanDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

/** Selector hook shape for the session projection seat. */
type UseProjection = (key: string) => unknown

/** Dock body; renders nothing without a projected plan. */
export function PlanDock(props: PlanDockProps): React.ReactElement | null {
  const useProjection = (props as { readonly useProjection?: UseProjection }).useProjection
  const projected = typeof useProjection === 'function' ? useProjection('endeavourPlan') : undefined
  const data = projected as EndeavourCardData | null | undefined
  if (data === undefined || data === null) return null
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
