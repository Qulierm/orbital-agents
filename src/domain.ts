/**
 * Endeavour plan domain: strongly typed ids, whole-value checkpoint events, the
 * legal four-state task machine, and pure transition functions.
 *
 * Every durable event carries the complete plan snapshot (`plan`) plus the
 * transition that produced it, so tail replay only needs the newest event and
 * a truncated log never yields a half-folded plan.
 */

// Type-only: resolves the module this file augments with `endeavour/plan`.
import type {} from '@deepseek-ai/dsh-session/types'

/** Durable identity of one Endeavour plan. */
export type PlanId = string & { readonly __brand: 'PlanId' }/** Durable identity of one plan task. */
export type TaskId = string & { readonly __brand: 'TaskId' }

/** Brand a raw string as a {@link PlanId}. */
export function PlanId(value: string): PlanId {
  return value as PlanId
}

/** Brand a raw string as a {@link TaskId}. */
export function TaskId(value: string): TaskId {
  return value as TaskId
}

/** The exact four user-visible task states. */
export type TaskStatus = 'waiting' | 'running' | 'succeeded' | 'failed'

/** The exact four user-visible task states, in lifecycle order. */
export const TASK_STATUSES = ['waiting', 'running', 'succeeded', 'failed'] as const satisfies readonly TaskStatus[]

/** Terminal plan outcome. */
export type PlanOutcome = 'completed' | 'failed'

/** The short projection of a task that the user sees on the card. */
export interface TaskDisplay {
  /** Short user-visible title. */
  readonly title: string
}

/**
 * The detailed projection of a task. It is stored in the durable plan for the
 * Builder and the verification seam, and MUST NOT be rendered by the card.
 */
export interface TaskExecution {
  /** Full instructions for the Builder. */
  readonly instructions: string
  /** Acceptance criteria the Builder must validate against. */
  readonly validation: string
  /** Optional execution constraints carried into the Builder brief. */
  readonly constraints?: string
}

/** One planned task: a public title plus a private execution projection. */
export interface TaskSpec {
  readonly id: TaskId
  readonly display: TaskDisplay
  readonly execution: TaskExecution
}

/** Structured evidence submitted by the Builder. */
export interface TaskReport {
  readonly summary: string
  readonly files: readonly string[]
  readonly validation: string
  readonly blocker?: string
  readonly failure?: string
  /** Durable event time of the report. */
  readonly reportedAt: number
}

/**
 * The exact Builder route a plan was spawned with. Durable so an active or
 * terminal plan stays inspectable after the global preference changes.
 */
export interface PlanBuilderRoute {
  readonly provider: string
  readonly model: string
  /** Adapter-owned reasoning effort actually passed to the child, when any. */
  readonly reasoningEffort?: string
  /** True when the route followed the Planner instead of a custom pin. */
  readonly inherited: boolean
}

/** Durable state of one task. */
export interface TaskState {
  readonly spec: TaskSpec
  readonly status: TaskStatus
  /** Set by the Builder's explicit start, never by Endeavour. */
  readonly startedAt?: number
  /** Set when Endeavour records the terminal outcome. */
  readonly finishedAt?: number
  readonly report?: TaskReport
  /** Short verification or failure note shown on the card. */
  readonly note?: string
}

/** Durable delivery/outbox fact for one peer protocol relay. */
export interface PlanDelivery {
  /** Which protocol relay this fact tracks. */
  readonly kind: 'plan-ready' | 'review-ready'
  /** Retry key: pairId:planId:kind. */
  readonly key: string
  /** pending = checkpointed but not delivered; delivered = receipt recorded. */
  readonly status: 'pending' | 'delivered'
  /** When the fact was last written (ms). */
  readonly at: number
  /** Transport receipt for a delivered relay (opaque, transport-owned). */
  readonly receipt?: string
  /** Planned recipient (the persistent Challenger or the Endeavour root). */
  readonly targetSessionId: string
}

/** Durable lifecycle of one plan. */
export interface PlanState {
  readonly planId: PlanId
  /** Root/Endeavour session that owns the plan events. */
  readonly rootSessionId: string
  /**
   * LEGACY read-only fallback: the historical continuable Builder child. New
   * peer plans leave it unset and carry `challengerSessionId` instead; the
   * `planChallengerId` accessor reads both.
   */
  readonly childId?: string
  /** The persistent ordinary Challenger session (new peer plans). */
  readonly challengerSessionId?: string
  /** The durable pair both ordinary sessions belong to (new peer plans). */
  readonly pairId?: string
  /** Delivery/outbox facts for plan-ready and review-ready relays. */
  readonly deliveries?: readonly PlanDelivery[]
  /** Short plan title shown on the card. */
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Monotonic event sequence within the plan. */
  readonly sequence: number
  readonly tasks: readonly TaskState[]
  /** Exact route used to spawn the Builder child, once the plan exists. */
  readonly builderRoute?: PlanBuilderRoute
  /**
   * Durable execution brief delivered in the plan-ready relay (peer plans).
   * Private: never projected to the card, dock, or any public projection.
   */
  readonly executionBrief?: string
  /** Durable plan-wide constraints from the same briefing (private). */
  readonly planConstraints?: string
  readonly terminal?: {
    readonly outcome: PlanOutcome
    readonly at: number
    readonly note?: string
  }
}

/** Transition kinds persisted inside every checkpoint payload. */
export type PlanEventKind =
  | 'plan-created'
  | 'task-started'
  | 'task-reported'
  | 'task-verified'
  | 'plan-finalized'
  | 'delivery-pending'
  | 'delivery-settled'

/** The durable payload appended to the root session for every mutation. */
export interface PlanEventPayload {
  readonly kind: PlanEventKind
  readonly at: number
  readonly plan: PlanState
}

/** Error codes for rejected transitions and authorization failures. */
export type EndeavourErrorCode =
  | 'plan-blocked'
  | 'transition-invalid'
  | 'task-unknown'
  | 'task-not-current'
  | 'plan-active'
  | 'plan-terminal'
  | 'role-forbidden'
  | 'lineage-mismatch'
  | 'report-duplicate'

/** Typed failure for rejected plan operations. */
export class EndeavourError extends Error {
  override readonly name = 'EndeavourError'
  constructor(readonly code: EndeavourErrorCode, message: string) {
    super(message)
  }
}

/** Build the initial plan snapshot for a freshly created plan. */
export function createPlanState(input: {
  readonly planId: PlanId
  readonly rootSessionId: string
  /** Legacy child id; peer plans pass `challengerSessionId` instead. */
  readonly childId?: string
  /** Canonical peer ownership for new plans. */
  readonly challengerSessionId?: string
  readonly pairId?: string
  readonly title: string
  readonly tasks: readonly TaskSpec[]
  readonly at: number
  readonly builderRoute?: PlanBuilderRoute
  readonly deliveries?: readonly PlanDelivery[]
  /** Private briefing inputs, stored so plan-ready is rebuildable after restart. */
  readonly executionBrief?: string
  readonly planConstraints?: string
}): PlanState {
  if (input.childId === undefined && input.challengerSessionId === undefined) {
    throw new EndeavourError('transition-invalid', 'a plan needs a Builder child or a Challenger session')
  }
  if (input.tasks.length === 0) {
    throw new EndeavourError('transition-invalid', 'a plan needs at least one task')
  }
  const ids = new Set<string>()
  for (const task of input.tasks) {
    if (ids.has(task.id)) {
      throw new EndeavourError('transition-invalid', `duplicate task id ${task.id}`)
    }
    ids.add(task.id)
    if (task.display.title.trim() === '') {
      throw new EndeavourError('transition-invalid', `task ${task.id} has an empty display title`)
    }
    if (task.execution.instructions.trim() === '') {
      throw new EndeavourError('transition-invalid', `task ${task.id} has empty instructions`)
    }
    if (task.execution.validation.trim() === '') {
      throw new EndeavourError('transition-invalid', `task ${task.id} has empty validation`)
    }
  }
  return {
    planId: input.planId,
    rootSessionId: input.rootSessionId,
    ...(input.childId === undefined ? {} : { childId: input.childId }),
    ...(input.challengerSessionId === undefined ? {} : { challengerSessionId: input.challengerSessionId }),
    ...(input.pairId === undefined ? {} : { pairId: input.pairId }),
    title: input.title,
    createdAt: input.at,
    updatedAt: input.at,
    sequence: 0,
    tasks: input.tasks.map((spec) => ({ spec, status: 'waiting' as const })),
    ...(input.builderRoute === undefined ? {} : { builderRoute: input.builderRoute }),
    ...(input.deliveries === undefined ? {} : { deliveries: input.deliveries }),
    ...(input.executionBrief === undefined ? {} : { executionBrief: input.executionBrief }),
    ...(input.planConstraints === undefined ? {} : { planConstraints: input.planConstraints }),
  }
}

/**
 * Canonical owner id of one plan's executor: the persistent Challenger for new
 * peer plans, the legacy continuable child for historical snapshots.
 */
export function planChallengerId(plan: PlanState): string {
  const id = plan.challengerSessionId ?? plan.childId
  if (id === undefined) throw new EndeavourError('transition-invalid', `plan ${plan.planId} has no executor session`)
  return id
}

/** True when the plan carries the legacy child lineage (historical snapshot). */
export function isLegacyChildPlan(plan: PlanState): boolean {
  return plan.challengerSessionId === undefined && plan.childId !== undefined
}

/** Current delivery fact for one protocol relay key, if any. */
export function deliveryFact(plan: PlanState, key: string): PlanDelivery | undefined {
  return plan.deliveries?.find((fact) => fact.key === key)
}

/** Every pending (checkpointed but undelivered) relay, in order. */
export function pendingDeliveries(plan: PlanState): readonly PlanDelivery[] {
  return (plan.deliveries ?? []).filter((fact) => fact.status === 'pending')
}

function replaceDelivery(plan: PlanState, fact: PlanDelivery): PlanState {
  const existing = plan.deliveries ?? []
  const index = existing.findIndex((candidate) => candidate.key === fact.key)
  const deliveries = index < 0
    ? [...existing, fact]
    : existing.map((candidate, at) => (at === index ? fact : candidate))
  return { ...plan, deliveries }
}

/**
 * Checkpoint a relay as pending BEFORE any transport attempt, so a crash
 * between the plan mutation and the delivery can be reconciled on recovery.
 */
export function markDeliveryPending(plan: PlanState, fact: Omit<PlanDelivery, 'status'>, at: number): PlanState {
  const existing = deliveryFact(plan, fact.key)
  if (existing?.status === 'delivered') return plan
  return { ...replaceDelivery(plan, { ...fact, status: 'pending', at }), updatedAt: at }
}

/** Record a successful delivery receipt; idempotent for the same key. */
export function markDeliveryDelivered(plan: PlanState, key: string, receipt: string | undefined, at: number): PlanState {
  const existing = deliveryFact(plan, key)
  if (existing === undefined) {
    throw new EndeavourError('transition-invalid', `no pending delivery ${key} to settle`)
  }
  if (existing.status === 'delivered') return plan
  return {
    ...replaceDelivery(plan, {
      ...existing,
      status: 'delivered',
      at,
      ...(receipt === undefined ? {} : { receipt }),
    }),
    updatedAt: at,
  }
}

function replaceTask(plan: PlanState, taskId: TaskId, update: (task: TaskState) => TaskState): PlanState {
  const index = plan.tasks.findIndex((task) => task.spec.id === taskId)
  if (index < 0) throw new EndeavourError('task-unknown', `unknown task ${taskId}`)
  const tasks = plan.tasks.map((task, at) => (at === index ? update(task) : task))
  return { ...plan, tasks }
}

function assertActive(plan: PlanState): void {
  if (plan.terminal !== undefined) {
    throw new EndeavourError('plan-terminal', `plan ${plan.planId} is ${plan.terminal.outcome}`)
  }
}

/** Builder execution cursor: the first task without a report, in plan order. */
export function executionCursor(plan: PlanState): TaskState | undefined {
  return plan.tasks.find((task) => task.report === undefined)
}

/** Endeavour review cursor: the first REPORTED task still awaiting a verdict. */
export function reviewCursor(plan: PlanState): TaskState | undefined {
  return plan.tasks.find((task) =>
    task.report !== undefined && task.status !== 'succeeded' && task.status !== 'failed')
}

/** Whether every task carries a Builder report (execution finished). */
export function allTasksReported(plan: PlanState): boolean {
  return plan.tasks.every((task) => task.report !== undefined)
}

/** The first report carrying blocker/failure evidence, when any. */
export function firstBlockedReport(plan: PlanState): TaskState | undefined {
  return plan.tasks.find((task) => task.report?.blocker !== undefined || task.report?.failure !== undefined)
}

/**
 * Display current: while executing it is the unreported active task; once every
 * task has a report it is the first Finished task still awaiting review.
 */
export function currentTask(plan: PlanState): TaskState | undefined {
  return allTasksReported(plan) ? reviewCursor(plan) : executionCursor(plan)
}

/** Index of the current eligible task, or -1. */
export function currentTaskIndex(plan: PlanState): number {
  return plan.tasks.findIndex((task) => task.spec.id === currentTask(plan)?.spec.id)
}

/**
 * Start the current task. Legal only from `waiting` on the first non-terminal
 * task; duplicates and out-of-order starts are rejected.
 */
export function startTask(plan: PlanState, taskId: TaskId, at: number): PlanState {
  assertActive(plan)
  // A blocker/failure report stops Builder progression immediately.
  const blocked = firstBlockedReport(plan)
  if (blocked !== undefined) {
    throw new EndeavourError('plan-blocked', `task ${blocked.spec.id} reported a blocker or failure`)
  }
  // Builder may start the next task as soon as every prior task has a report,
  // without waiting for an Endeavour verdict.
  const cursor = executionCursor(plan)
  if (cursor === undefined || cursor.spec.id !== taskId) {
    throw new EndeavourError('task-not-current', `task ${taskId} is not the current executable task`)
  }
  if (cursor.status !== 'waiting') {
    throw new EndeavourError('transition-invalid', `task ${taskId} is already ${cursor.status}`)
  }
  return {
    ...replaceTask(plan, taskId, (task) => ({ ...task, status: 'running', startedAt: at })),
    updatedAt: at,
  }
}

/**
 * Submit the Builder's structured report. Legal only from `running`; the public
 * row stays running while Endeavour checks, and the report is evidence only.
 */
export function reportTask(plan: PlanState, taskId: TaskId, report: Omit<TaskReport, 'reportedAt'>, at: number): PlanState {
  assertActive(plan)
  const task = plan.tasks.find((candidate) => candidate.spec.id === taskId)
  if (task === undefined) throw new EndeavourError('task-unknown', `unknown task ${taskId}`)
  if (task.status === 'waiting') {
    throw new EndeavourError('transition-invalid', `task ${taskId} has not started`)
  }
  if (task.status !== 'running') {
    throw new EndeavourError('report-duplicate', `task ${taskId} already has a terminal outcome`)
  }
  if (task.report !== undefined) {
    throw new EndeavourError('report-duplicate', `task ${taskId} already reported`)
  }
  // Reports stay sequential: only the execution cursor may report, and an
  // earlier blocker/failure stops all later progression.
  const blocked = firstBlockedReport(plan)
  if (blocked !== undefined) {
    throw new EndeavourError('plan-blocked', `task ${blocked.spec.id} reported a blocker or failure`)
  }
  const cursor = executionCursor(plan)
  if (cursor === undefined || cursor.spec.id !== taskId) {
    throw new EndeavourError('task-not-current', `task ${taskId} is not the reported task`)
  }
  return {
    ...replaceTask(plan, taskId, (state) => ({ ...state, report: { ...report, reportedAt: at } })),
    updatedAt: at,
  }
}

/**
 * Record Endeavour's quick-check verdict. Legal only from `running` with a
 * submitted report. Freezes the duration at `at` and finalizes the plan when
 * the last task succeeds or any task fails.
 */
export function verifyTask(
  plan: PlanState,
  taskId: TaskId,
  outcome: 'succeeded' | 'failed',
  note: string | undefined,
  at: number,
): PlanState {
  assertActive(plan)
  const task = plan.tasks.find((candidate) => candidate.spec.id === taskId)
  if (task === undefined) throw new EndeavourError('task-unknown', `unknown task ${taskId}`)
  if (task.report === undefined) {
    throw new EndeavourError('transition-invalid', `task ${taskId} has no submitted report`)
  }
  if (task.status !== 'running') {
    throw new EndeavourError('transition-invalid', `task ${taskId} is already ${task.status}`)
  }
  // Review starts only once every task has a report, or immediately for an
  // early blocker/failure; review itself is strictly ordered and never
  // dispatches work.
  if (!allTasksReported(plan) && firstBlockedReport(plan) === undefined) {
    throw new EndeavourError('transition-invalid', `plan still has unreported tasks`)
  }
  const cursor = reviewCursor(plan)
  if (cursor?.spec.id !== taskId) {
    throw new EndeavourError('task-not-current', `task ${taskId} is not the current review task`)
  }
  const withVerdict = replaceTask(plan, taskId, (state) => ({
    ...state,
    status: outcome,
    // Duration freezes at the report time for Finished AND Confirmed rows.
    finishedAt: state.report?.reportedAt ?? at,
    ...(note === undefined ? {} : { note }),
  }))
  const allSucceeded = withVerdict.tasks.every((state) => state.status === 'succeeded')
  const failed = withVerdict.tasks.some((state) => state.status === 'failed')
  const terminal = outcome === 'failed'
    ? { outcome: 'failed' as const, at, ...(note === undefined ? {} : { note }) }
    : allSucceeded
      ? { outcome: 'completed' as const, at }
      : undefined
  return {
    ...withVerdict,
    updatedAt: at,
    ...(terminal === undefined ? {} : { terminal }),
  }
}

/** Task states that need a Builder continuation, i.e. the next detailed brief. */export function nextDispatch(plan: PlanState, taskId: TaskId): TaskSpec | undefined {
  if (plan.terminal !== undefined) return undefined
  const index = plan.tasks.findIndex((state) => state.spec.id === taskId)
  if (index < 0) return undefined
  return plan.tasks[index + 1]?.spec
}

/** Live or frozen duration of one task, in milliseconds. */
export function taskDurationMs(task: TaskState, now: number): number | undefined {
  if (task.startedAt === undefined) return undefined
  // A report freezes the duration at reportedAt (Finished), and confirmation
  // keeps that same value because finishedAt is set to reportedAt.
  const end = task.finishedAt ?? task.report?.reportedAt ?? now
  return Math.max(0, end - task.startedAt)
}

/** Public status mapping: an internal report awaiting verification stays running. */
export function publicTaskStatus(task: TaskState): TaskStatus {
  return task.status
}

/** Rebuild the newest plan snapshot from a replayed event tail. */
export function foldPlanEvents(events: readonly PlanEventPayload[]): PlanState | undefined {
  let newest: PlanState | undefined
  for (const event of events) {
    if (newest === undefined || event.plan.sequence >= newest.sequence) newest = event.plan
  }
  return newest
}

/** Build the checkpoint payload appended for one transition. */
export function planEventPayload(kind: PlanEventKind, previous: PlanState | undefined, plan: PlanState, at: number): PlanEventPayload {
  return {
    kind,
    at,
    plan: { ...plan, sequence: (previous?.sequence ?? 0) + 1, updatedAt: at },
  }
}

/** Authorization helpers -------------------------------------------------- */

/** Accept only the plan's owning root session. */
export function assertRootRole(plan: PlanState, sessionId: string): void {
  if (plan.rootSessionId !== sessionId) {
    throw new EndeavourError('role-forbidden', `session ${sessionId} is not the plan root`)
  }
}

/**
 * @deprecated Legacy continuable-child lineage check; new peer paths use
 * `assertPairedChallenger` in peer-auth.ts. Kept for the historical service
 * until the C2 cutover.
 */

/** Accept only the exact continuable child under its exact direct parent. */
export function assertChildRole(plan: PlanState, sessionId: string, parentSessionId: string | undefined): void {
  if (plan.childId !== sessionId) {
    throw new EndeavourError('lineage-mismatch', `session ${sessionId} is not the plan Builder child`)
  }
  if (parentSessionId === undefined || plan.rootSessionId !== parentSessionId) {
    throw new EndeavourError('lineage-mismatch', 'Builder session is not a direct child of the plan root')
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One whole-value Endeavour plan checkpoint. */
    'endeavour/plan': PlanEventPayload
  }
}
