/**
 * Shared plan projection: the one pure fold from durable `endeavour/plan`
 * checkpoints to the card payload rendered by both surfaces. Host projection,
 * transcript definition, and tests all use these functions.
 */

import { foldPlanEvents, type PlanEventPayload, type PlanState, type TaskState, type TaskStatus, type PlanOutcome } from './domain.js'

/**
 * Display stage derived from durable state; it never changes the persisted
 * legality of `waiting | running | succeeded | failed`.
 *
 * - `waiting`: not started yet.
 * - `working`: running without a submitted Builder report.
 * - `finished`: running with a report awaiting Endeavour's quick check.
 * - `confirmed`: Endeavour verified success.
 * - `failed`: Endeavour recorded failure (exceptional outcome).
 */
export type TaskStage = 'waiting' | 'working' | 'finished' | 'confirmed' | 'failed'

/** Derive the presentation stage for one durable task state. */
export function taskStage(task: TaskState): TaskStage {
  if (task.status === 'waiting') return 'waiting'
  if (task.status === 'running') return task.report === undefined ? 'working' : 'finished'
  if (task.status === 'succeeded') return 'confirmed'
  return 'failed'
}

/** One row of the rendered card. */
export interface EndeavourCardTask {
  readonly id: string
  /** Short user-visible title only; never detailed instructions. */
  readonly title: string
  /** Durable status; only Endeavour can move it to succeeded/failed. */
  readonly status: TaskStatus
  /** Derived display stage shown by the UI. */
  readonly stage: TaskStage
  /** Durable start time (ms), used for the live mm:ss timer. */
  readonly startedAt?: number
  /** Terminal freeze time (ms), set by Endeavour verification. */
  readonly finishedAt?: number
  /** Builder report time (ms): freezes the Finished stage duration. */
  readonly reportedAt?: number
  /** Short verification or failure note. */
  readonly note?: string
}

/** Final renderer payload for one plan card. */
export interface EndeavourCardData {
  readonly planId: string
  /** Root/Endeavour session that owns the plan and the Builder child. */
  readonly rootSessionId: string
  readonly title: string
  readonly tasks: readonly EndeavourCardTask[]
  /** Confirmed task count (succeeded and verified by Endeavour). */
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
    stage: taskStage(task),
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
    ...(task.report === undefined ? {} : { reportedAt: task.report.reportedAt }),
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
    rootSessionId: plan.rootSessionId,
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
