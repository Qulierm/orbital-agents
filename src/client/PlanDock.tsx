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

import { useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EndeavourCardData } from '../plan-projection.js'
import { NS, type EndeavourKey } from './locales.js'
import { copyFrom, type EndeavourInjected } from './PlanCard.js'
import { planAction } from './plan-action.js'
import { PlanView } from './PlanView.js'

/** Complete dock renderer props (session scope supplies `useProjection`). */
export type PlanDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

/** Selector hook shape for the session projection seat. */
type UseProjection = (key: string) => unknown

const noopSubscribe = (): (() => void) => () => undefined
const noopSnapshot = (): null => null

/** Dock body; renders nothing without a projected plan. */
export function PlanDock(props: PlanDockProps): React.ReactElement | null {
  const useProjection = (props as { readonly useProjection?: UseProjection }).useProjection
  // Cross-session source: on the paired Challenger this subscribes to the
  // Endeavour root's official `endeavourPlan` face, so both peers render the
  // SAME canonical plan data without duplicating any durable events.
  const source = props.planSource
  const external = useSyncExternalStore(
    source?.subscribe ?? noopSubscribe,
    source?.getSnapshot ?? noopSnapshot,
    source?.getSnapshot ?? noopSnapshot,
  )
  const projected = typeof useProjection === 'function' ? useProjection('endeavourPlan') : undefined
  const own = projected as EndeavourCardData | null | undefined
  const data = (own ?? (external as EndeavourCardData | null | undefined)) ?? null
  if (data === null) return null
  return (
    <PlanView
      data={data}
      copy={copyFrom(props)}
      action={planAction(data, props.currentSessionId)}
      onOpenBuilder={(target) => { props.openCounterpart(target) }}
      variant="dock"
    />
  )
}

/**
 * Stable dock id and deliberate very-high finite order: the plan dock is the
 * attached-to-composer surface, so it must be the LAST `conversation.input.dock`
 * occupant before InputBar. Native todo (0) and third-party strips such as
 * dsh-cost-meter (5) sort above it and can never render between the dock and
 * the composer. Sorting stays stable.
 */
export const PLAN_DOCK_ID = 'endeavour-plan'
export const PLAN_DOCK_ORDER = 1000

/** Registers the composer plan dock with the shared injected navigation. */
export function registerPlanDock(slots: {
  inject(name: string, callback: () => void): void
  register(options: { name: string; id: string; order: number; locale: string; inject?: () => unknown }, component: unknown): void
}, injectProps: () => EndeavourInjected): void {
  slots.inject('conversation.input.dock', () => slots.register(
    { name: 'conversation.input.dock', id: PLAN_DOCK_ID, order: PLAN_DOCK_ORDER, locale: NS, inject: injectProps },
    PlanDock as unknown as (props: PlanDockProps) => unknown,
  ))
}

/** Copy helper re-exported for tests. */
export type { EndeavourKey }
