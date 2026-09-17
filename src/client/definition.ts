/**
 * Browser-side Conversation Node Definition for the durable `endeavour/plan`
 * event family. Events are appended only to the root/Endeavour session, so the
 * plan card can never match in the Builder child chat.
 *
 * The card types and projection live in the shared `plan-projection` module so
 * the host session projection, this definition, and the tests fold one source.
 */

import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PlanEventPayload, PlanState } from '../domain.js'
import { projectPlanCard, type EndeavourCardData, type EndeavourCardTask } from '../plan-projection.js'

export type { EndeavourCardData, EndeavourCardTask }

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One durable Endeavour plan card. */
    'endeavour-plan': EndeavourCardData
  }
}

function isPlanState(value: unknown): value is PlanState {
  if (typeof value !== 'object' || value === null) return false
  const plan = value as Partial<PlanState>
  return typeof plan.planId === 'string'
    && typeof plan.rootSessionId === 'string'
    && typeof plan.childId === 'string'
    && typeof plan.sequence === 'number'
    && Array.isArray(plan.tasks)
}

function eventPlan(event: { readonly type: string; readonly data: unknown }): PlanState | null {
  if (event.type !== 'endeavour/plan') return null
  const payload = event.data as Partial<PlanEventPayload>
  return isPlanState(payload?.plan) ? payload.plan : null
}

/** Durable `endeavour/plan` family folded into one keyed Chat node. */
export const endeavourPlanDefinition: ConversationNodeDefinition<PlanState> = {
  kind: 'endeavour-plan',
  target: 'chat',
  match: (event) => {
    const plan = eventPlan(event)
    if (plan === null) return null
    const payload = (event as { readonly data?: Partial<PlanEventPayload> }).data
    return { id: String(plan.planId), role: payload?.kind === 'plan-created' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const plan = eventPlan(match.event)
    if (plan === null) throw new Error('endeavour-plan start requires an endeavour/plan event')
    return plan
  },
  update: (context: ConversationNodeContext<PlanState> & { readonly state: PlanState }, match: ConversationMatch) => {
    const plan = eventPlan(match.event)
    // Whole-value checkpoints: the newest sequence wins; stale replays are ignored.
    return plan === null || plan.sequence < context.state.sequence ? context.state : plan
  },
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: 'endeavour-plan',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: projectPlanCard(context.state),
    }
  },
}
