/**
 * Durable Endeavour orchestration service.
 *
 * One active plan per root session, one continuable Builder child, sequential
 * tasks. Every mutation appends a whole-value checkpoint event to the root
 * session log, flushes durability, and is serialized per root.
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertChildRole,
  assertRootRole,
  createPlanState,
  EndeavourError,
  foldPlanEvents,
  nextDispatch,
  PlanId,
  planEventPayload,
  reportTask,
  startTask,
  TaskId,
  verifyTask,
  type PlanEventPayload,
  type PlanState,
  type TaskReport,
  type TaskSpec,
} from './domain.js'
import { BUILDER_PROMPT } from './prompts.js'

/** Durable event type appended to the Endeavour root session. */
export const ENDEAVOUR_EVENT_TYPE = 'endeavour/plan'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** One whole-value Endeavour plan checkpoint. */
    'endeavour/plan': PlanEventPayload
  }
}

/** Plugin configuration accepted from the bundle row. */
export interface EndeavourConfig {
  /** Registered `ctx.subagents` provider used for the continuable Builder. */
  readonly builderProvider?: string
  /**
   * Optional Builder model route. When omitted the child inherits the parent
   * Agent options, so cost separation requires choosing a cheap route here.
   */
  readonly builderAgentOptions?: AgentOptions
  /** Per-child persona; defaults to the project Builder prompt. */
  readonly builderPersona?: string
  /** Child tool scope; defaults to a Builder-safe allow list. */
  readonly builderToolFilter?: ToolRestriction
  /** Delegation depth cap passed to the provider. */
  readonly maxDepth?: number
}

/** Minimal Agent shape this service reads, kept narrow for test fakes. */
interface AgentLike {
  readonly session?: { readonly id?: unknown; readonly parentId?: unknown; readonly parentSessionId?: unknown }
  readonly id?: unknown
  readonly parentSessionId?: unknown
  readonly parent?: { readonly id?: unknown; readonly session?: { readonly id?: unknown } }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The calling Agent's durable session id. */
export function agentSessionId(agent: unknown): string | undefined {
  const candidate = agent as AgentLike | undefined
  return stringOf(candidate?.session?.id) ?? stringOf(candidate?.id)
}

/** The calling Agent's direct parent session id, when the runtime exposes it. */
export function agentParentSessionId(agent: unknown): string | undefined {
  const candidate = agent as AgentLike | undefined
  return stringOf(candidate?.parentSessionId)
    ?? stringOf(candidate?.session?.parentId)
    ?? stringOf(candidate?.session?.parentSessionId)
    ?? stringOf(candidate?.parent?.session?.id)
    ?? stringOf(candidate?.parent?.id)
}

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

/** Minimal host views, kept narrow so tests can pass fakes. */
interface SessionHost {
  get(id: string): Session | undefined
  flush(session: Session): Promise<boolean>
  list(): readonly Session[]
}

interface SubagentHost {
  startContinuable(spec: unknown): Promise<{ childId: string }>
  sendMessage(sender: Agent, targetId: string, content: ContentBlock[], options: { signal: AbortSignal }): Promise<unknown>
}

/** One structured Builder report accepted by the service. */
export interface BuilderReportInput {
  readonly summary: string
  readonly files: readonly string[]
  readonly validation: string
  readonly blocker?: string
  readonly failure?: string
}

/** Outcome of plan creation. */
export interface PlanCreation {
  readonly planId: string
  readonly childId: string
  readonly taskCount: number
}

/**
 * Root/child orchestration shared by the tools. All session writes go through
 * this service; tools own only argument validation.
 */
export class EndeavourService extends Service {
  readonly #plans = new Map<string, PlanState>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #config: EndeavourConfig

  constructor(ctx: Context, config: EndeavourConfig = {}) {
    super(ctx, 'endeavour')
    this.#config = config
    this.#recoverExistingPlans()
  }

  /** Serialize one mutation per root session. */
  #enqueue<T>(rootSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(rootSessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.#queues.set(rootSessionId, next.catch(() => undefined))
    return next
  }

  /** The active (non-terminal) plan for a root session, if any. */
  getActivePlan(rootSessionId: string): PlanState | undefined {
    const plan = this.#plans.get(rootSessionId)
    return plan !== undefined && plan.terminal === undefined ? plan : undefined
  }

  /** The plan whose Builder child is this session, if any. */
  getPlanByChild(childId: string): PlanState | undefined {
    for (const plan of this.#plans.values()) if (plan.childId === childId) return plan
    return undefined
  }

  /** Rebuild in-memory plans from already-loaded root sessions (replay recovery). */
  #recoverExistingPlans(): void {
    const host = this.#sessionHost()
    for (const session of host?.list() ?? []) this.adoptSession(session)
  }

  #sessionHost(): SessionHost | undefined {
    return (this.ctx as unknown as { sessions?: SessionHost }).sessions
  }

  #subagentHost(): SubagentHost {
    const host = (this.ctx as unknown as { subagents?: SubagentHost }).subagents
    if (host === undefined) {
      throw new EndeavourError('role-forbidden', 'subagent service is unavailable')
    }
    return host
  }

  /** Fold one session's Endeavour events into the durable plan index. */
  adoptSession(session: Session): PlanState | undefined {
    const events: PlanEventPayload[] = []
    const count = session.seq as unknown as number
    for (let seq = 0; seq < count; seq += 1) {
      const event = session.eventAt(seq as never) as SessionEvent | undefined
      if (event === undefined || event.type !== ENDEAVOUR_EVENT_TYPE) continue
      events.push(event.data)
    }
    const plan = foldPlanEvents(events)
    if (plan !== undefined) this.#plans.set(plan.rootSessionId, plan)
    return plan
  }

  /** Append one checkpoint to its owning root session and flush durability. */
  async #append(rootSessionId: string, kind: PlanEventPayload['kind'], previous: PlanState | undefined, plan: PlanState, at: number): Promise<void> {
    const sessions = this.#sessionHost()
    const session = sessions?.get(rootSessionId)
    if (session === undefined) {
      throw new EndeavourError('role-forbidden', `root session ${rootSessionId} is not loaded`)
    }
    const payload = planEventPayload(kind, previous, plan, at)
    session.append(ENDEAVOUR_EVENT_TYPE, payload)
    await sessions?.flush(session)
    this.#plans.set(rootSessionId, payload.plan)
  }

  /**
   * Create the single active plan and start the continuable Builder child.
   * The child starts with the first detailed task; later tasks are dispatched
   * by verification.
   */
  async createPlan(agent: Agent, input: {
    readonly title: string
    readonly brief: string
    readonly constraints?: string
    readonly tasks: readonly TaskSpec[]
  }): Promise<PlanCreation> {
    const rootSessionId = agentSessionId(agent)
    if (rootSessionId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    return this.#enqueue(rootSessionId, async () => {
      if (this.getActivePlan(rootSessionId) !== undefined) {
        throw new EndeavourError('plan-active', 'this Endeavour session already has an active plan')
      }
      const at = Date.now()
      const planId = PlanId(randomUUID())
      const first = input.tasks[0]
      if (first === undefined) throw new EndeavourError('transition-invalid', 'a plan needs at least one task')
      const subagents = this.#subagentHost()
      const started = await subagents.startContinuable({
        provider: this.#config.builderProvider ?? 'spawn',
        label: 'Builder',
        request: {
          parent: agent,
          prompt: [textBlock(builderBrief(input.brief, input.constraints, first))],
          ...(this.#config.builderAgentOptions === undefined ? {} : { agentOptions: this.#config.builderAgentOptions }),
          persona: this.#config.builderPersona ?? BUILDER_PROMPT,
          ...(this.#config.builderToolFilter === undefined ? {} : { toolFilter: this.#config.builderToolFilter }),
          ...(this.#config.maxDepth === undefined ? {} : { maxDepth: this.#config.maxDepth }),
        },
        signal: new AbortController().signal,
      })
      const childId = String(started.childId)
      const plan = createPlanState({
        planId,
        rootSessionId,
        childId,
        title: input.title,
        tasks: input.tasks,
        at,
      })
      await this.#append(rootSessionId, 'plan-created', undefined, plan, at)
      return { planId: plan.planId, childId, taskCount: plan.tasks.length }
    })
  }

  /** Builder-only: start the current task exactly once, at explicit start time. */
  async builderStartTask(agent: Agent, taskId: string): Promise<PlanState> {
    const childId = agentSessionId(agent)
    if (childId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.getPlanByChild(childId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${childId} is not a plan Builder`)
    return this.#enqueue(plan.rootSessionId, async () => {
      const current = this.#plans.get(plan.rootSessionId) ?? plan
      assertChildRole(current, childId, agentParentSessionId(agent) ?? current.rootSessionId)
      const at = Date.now()
      const next = startTask(current, TaskId(taskId), at)
      await this.#append(current.rootSessionId, 'task-started', current, next, at)
      return next
    })
  }

  /**
   * Builder-only: submit the report and steer the exact direct parent with a
   * compact verification request. The public row stays running.
   */
  async builderReport(agent: Agent, taskId: string, report: BuilderReportInput): Promise<PlanState> {
    const childId = agentSessionId(agent)
    if (childId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.getPlanByChild(childId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${childId} is not a plan Builder`)
    return this.#enqueue(plan.rootSessionId, async () => {
      const current = this.#plans.get(plan.rootSessionId) ?? plan
      assertChildRole(current, childId, agentParentSessionId(agent) ?? current.rootSessionId)
      const at = Date.now()
      const next = reportTask(current, TaskId(taskId), {
        summary: report.summary,
        files: [...report.files],
        validation: report.validation,
        ...(report.blocker === undefined ? {} : { blocker: report.blocker }),
        ...(report.failure === undefined ? {} : { failure: report.failure }),
      }, at)
      await this.#append(current.rootSessionId, 'task-reported', current, next, at)
      const task = next.tasks.find((candidate) => candidate.spec.id === taskId)
      const subagents = this.#subagentHost()
      await subagents.sendMessage(agent, current.rootSessionId, [
        textBlock([
          `Builder report for task "${task?.spec.display.title ?? taskId}" (${taskId}).`,
          `Summary: ${report.summary}`,
          `Files: ${report.files.join(', ') || 'none'}`,
          `Validation: ${report.validation}`,
          report.blocker === undefined ? '' : `Blocker: ${report.blocker}`,
          report.failure === undefined ? '' : `Failure: ${report.failure}`,
          'Check the acceptance criteria and record the verdict with endeavour_verify.',
        ].filter((line) => line !== '').join('\n')),
      ], { signal: new AbortController().signal })
      return next
    })
  }

  /**
   * Root-only quick verification. Freezes the duration, finalizes the plan on
   * last success or any failure, and dispatches the next detailed task to the
   * same Builder child on success.
   */
  async verifyTask(agent: Agent, taskId: string, outcome: 'succeeded' | 'failed', note?: string): Promise<PlanState> {
    const rootSessionId = agentSessionId(agent)
    if (rootSessionId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.#plans.get(rootSessionId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${rootSessionId} has no plan`)
    return this.#enqueue(rootSessionId, async () => {
      const current = this.#plans.get(rootSessionId) ?? plan
      assertRootRole(current, rootSessionId)
      const at = Date.now()
      const next = verifyTask(current, TaskId(taskId), outcome, note, at)
      await this.#append(rootSessionId, next.terminal === undefined ? 'task-verified' : 'plan-finalized', current, next, at)
      if (next.terminal === undefined && outcome === 'succeeded') {
        const dispatch = nextDispatch(current, TaskId(taskId))
        if (dispatch !== undefined) {
          const subagents = this.#subagentHost()
          await subagents.sendMessage(agent, next.childId, [
            textBlock(builderBrief(undefined, undefined, dispatch)),
          ], { signal: new AbortController().signal })
        }
      }
      if (next.terminal?.outcome === 'failed') {
        const running = next.tasks.find((task) => task.status === 'running')
        if (running !== undefined) {
          // Defensive: a failure verdict on the current task cannot leave others running.
          throw new EndeavourError('transition-invalid', 'failure verdict left a running task')
        }
      }
      return next
    })
  }
}

/** Compose the detailed Builder brief for one task. Never rendered on the card. */
export function builderBrief(brief: string | undefined, constraints: string | undefined, task: TaskSpec): string {
  return [
    brief === undefined ? '' : brief,
    constraints === undefined ? '' : `Constraints: ${constraints}`,
    `Task: ${task.display.title}`,
    'Instructions:',
    task.execution.instructions,
    'Validation criteria:',
    task.execution.validation,
    `Call builder_start_task with task_id "${task.id}" before executing, and builder_report with your evidence when done.`,
  ].filter((line) => line !== '').join('\n')
}

/** Typed report accepted from the model (kept separate from the service input). */
export type { TaskReport }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Endeavour orchestration service provided by this plugin. */
    endeavour: EndeavourService
  }
}
