/**
 * Browser-side Conversation Node Definition for the durable `endeavour/plan`
 * event family. Events are appended only to the root/Endeavour session, so the
 * plan card can never match in the Builder child chat.
 */

import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PlanEventPayload, PlanState, TaskState, TaskStatus, PlanOutcome } from '../domain.js'

/** One row of the rendered card. */
export interface EndeavourCardTask {
  readonly id: string
  /** Short user-visible title only; never detailed instructions. */
  readonly title: string
  readonly status: TaskStatus
  /** Durable start time (ms), used for the live mm:ss timer. */
  readonly startedAt?: number
  /** Terminal freeze time (ms), set by Endeavour verification. */
  readonly finishedAt?: number
  /** Short verification or failure note. */
  readonly note?: string
}

/** Final renderer payload for one plan card. */
export interface EndeavourCardData {
  readonly planId: string
  readonly title: string
  readonly tasks: readonly EndeavourCardTask[]
  readonly completedCount: number
  readonly total: number
  /** Short title of the current task, if any. */
  readonly currentTitle?: string
  /** True while a Builder report awaits Endeavour's quick check. */
  readonly checking: boolean
  readonly terminal?: {
    readonly outcome: PlanOutcome
    readonly at: number
    readonly note?: string
  }
  /** The Builder child session for the Open Builder action. */
  readonly childId: string
}

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

function taskRow(task: TaskState): EndeavourCardTask {
  return {
    id: task.spec.id,
    title: task.spec.display.title,
    status: task.status,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.note === undefined ? {} : { note: task.note }),
  }
}

/** Project durable plan state into the exact card payload. */
export function projectPlanCard(plan: PlanState): EndeavourCardData {
  const completedCount = plan.tasks.filter((task) => task.status === 'succeeded').length
  const current = plan.tasks.find((task) => task.status === 'running')
  const checking = current?.report !== undefined
  const currentSpec = current?.spec.display.title
  return {
    planId: plan.planId,
    title: plan.title,
    tasks: plan.tasks.map(taskRow),
    completedCount,
    total: plan.tasks.length,
    ...(currentSpec === undefined ? {} : { currentTitle: currentSpec }),
    checking,
    ...(plan.terminal === undefined
      ? {}
      : {
          terminal: {
            outcome: plan.terminal.outcome,
            at: plan.terminal.at,
            ...(plan.terminal.note === undefined ? {} : { note: plan.terminal.note }),
          },
        }),
    childId: plan.childId,
  }
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
