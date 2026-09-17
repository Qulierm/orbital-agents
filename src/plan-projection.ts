/**
 * Shared plan projection: the one pure fold from durable `endeavour/plan`
 * checkpoints to the card payload rendered by both surfaces. Host projection,
 * transcript definition, and tests all use these functions.
 */

import { foldPlanEvents, type PlanEventPayload, type PlanState, type TaskState, type TaskStatus, type PlanOutcome } from './domain.js'

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

/** Latest whole card state from a replayed checkpoint sequence. */
export function latestPlanCard(events: readonly PlanEventPayload[]): EndeavourCardData | null {
  const plan = foldPlanEvents(events)
  return plan === undefined ? null : projectPlanCard(plan)
}
