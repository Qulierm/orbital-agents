/**
 * Durable Endeavour orchestration service.
 *
 * One active plan per root session, one continuable Builder child, sequential
 * tasks. Every mutation appends a whole-value checkpoint event to the root
 * session log, flushes durability, and is serialized per root.
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  defaultBuilderSettings,
  snapshotBuilderSettings,
  validateBuilderSettings,
  type BuilderRouteSettings,
} from './builder-settings.js'
import {
  PEER_EVENT_TYPE,
  PeerRegistry,
  foldPeerEvents,
  peerEventPayload,
  peerRoleOf,
  type PeerEventPayload,
  type PeerState,
} from './peer.js'
import { createCordisPeerSeam } from './peer-host.js'
import { projectPeerState } from './peer-projection.js'
import { PeerLifecycle, PeerProvisioner } from './peer-service.js'
import {
  assertChildRole,
  assertRootRole,
  createPlanState,
  EndeavourError,
  foldPlanEvents,
  allTasksReported,
  executionCursor,
  firstBlockedReport,
  nextDispatch,
  PlanId,
  planEventPayload,
  reportTask,
  startTask,
  TaskId,
  verifyTask,
  type PlanBuilderRoute,
  type PlanEventPayload,
  type PlanState,
  type TaskReport,
  type TaskSpec,
} from './domain.js'
import { BUILDER_PROMPT } from './prompts.js'

/** Durable event type appended to the Endeavour root session. */
export const ENDEAVOUR_EVENT_TYPE = 'endeavour/plan'

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
  /**
   * Child tool scope. When omitted the Builder-safe default deny list applies
   * (no ordinary parent messaging or delegation); explicit configuration
   * overrides that default verbatim.
   */
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
  private readonly plans = new Map<string, PlanState>()
  /** Durable peer pairs indexed from both ordinary sides. */
  private readonly peers = new PeerRegistry()
  private provisioner: PeerProvisioner | undefined
  private lifecycle: PeerLifecycle | undefined
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly serviceConfig: EndeavourConfig
  private builderSettings: () => BuilderRouteSettings

  constructor(ctx: Context, config: EndeavourConfig = {}) {
    super(ctx, 'endeavour')
    this.serviceConfig = config
    this.builderSettings = () => defaultBuilderSettings(config.builderAgentOptions ?? {})
    this.recoverExistingPlans()
  }

  /**
   * Adopt the live settings source installed by the Host Settings section.
   * The value is snapshotted at every plan creation, so later writes affect
   * only future Builder children.
   */
  setBuilderSettingsSource(source: () => BuilderRouteSettings): void {
    this.builderSettings = source
  }

  /** The current stored preference, defensively copied. */
  currentBuilderSettings(): BuilderRouteSettings {
    return snapshotBuilderSettings(this.builderSettings())
  }

  /**
   * Resolve the exact child options once, at plan creation time.
   * - custom: provider/model plus optional effort/maxTokens; the parent's
   *   route-owned effort is intentionally not carried over.
   * - inherit: the Planner's current route through the public upstream
   *   delegation helper.
   */
  private resolveBuilderRoute(agent: Agent): { options: Partial<AgentOptions>; route: PlanBuilderRoute } {
    const settings = this.currentBuilderSettings()
    const valid = validateBuilderSettings(settings).length === 0
    if (valid && settings.mode === 'custom' && settings.provider !== undefined && settings.model !== undefined) {
      return {
        options: {
          provider: settings.provider,
          model: settings.model,
          ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(settings.reasoningEffort) }),
          ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
        },
        route: {
          provider: settings.provider,
          model: settings.model,
          ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
          inherited: false,
        },
      }
    }
    let inherited: Partial<AgentOptions>
    try {
      inherited = parentAgentOptionsForDelegation(agent)
    } catch {
      // Session-less agents (tests, odd callers) fall back to their own options;
      // production parents always carry the session the helper reads.
      inherited = { ...(agent as { options?: AgentOptions }).options }
    }
    return {
      options: { ...inherited },
      route: {
        provider: inherited.provider ?? '',
        model: inherited.model ?? '',
        ...(inherited.reasoningEffort === undefined ? {} : { reasoningEffort: inherited.reasoningEffort }),
        inherited: true,
      },
    }
  }

  /** Serialize one mutation per root session. */
  private enqueue<T>(rootSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(rootSessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.queues.set(rootSessionId, next.catch(() => undefined))
    return next
  }

  /** The active (non-terminal) plan for a root session, if any. */
  getActivePlan(rootSessionId: string): PlanState | undefined {
    const plan = this.plans.get(rootSessionId)
    return plan !== undefined && plan.terminal === undefined ? plan : undefined
  }

  /** The plan whose Builder child is this session, if any. */
  getPlanByChild(childId: string): PlanState | undefined {
    for (const plan of this.plans.values()) if (plan.childId === childId) return plan
    return undefined
  }

  /** Rebuild in-memory plans from already-loaded root sessions (replay recovery). */
  private recoverExistingPlans(): void {
    const host = this.sessionHost()
    for (const session of host?.list() ?? []) this.adoptSession(session)
  }

  private sessionHost(): SessionHost | undefined {
    return (this.ctx as unknown as { sessions?: SessionHost }).sessions
  }

  private subagentHost(): SubagentHost {
    const host = (this.ctx as unknown as { subagents?: SubagentHost }).subagents
    if (host === undefined) {
      throw new EndeavourError('role-forbidden', 'subagent service is unavailable')
    }
    return host
  }

  /** Fold one session's Endeavour events into the durable plan index. */
  adoptSession(session: Session): PlanState | undefined {
    const events: PlanEventPayload[] = []
    const peerEvents: PeerEventPayload[] = []
    const count = session.seq as unknown as number
    for (let seq = 0; seq < count; seq += 1) {
      const event = session.eventAt(seq as never) as SessionEvent | undefined
      if (event === undefined) continue
      if (event.type === PEER_EVENT_TYPE) peerEvents.push(event.data)
      else if (event.type === ENDEAVOUR_EVENT_TYPE) events.push(event.data)
    }
    // Peer recovery indexes BOTH ordinary sides; a corrupt pair stays unused.
    const peer = foldPeerEvents(peerEvents)
    if (peer !== undefined) {
      try {
        this.peers.set(peer)
      } catch {
        // Invalid durable pair: ignored rather than poisoning recovery.
      }
    }
    const plan = foldPlanEvents(events)
    if (plan !== undefined) this.plans.set(plan.rootSessionId, plan)
    return plan
  }

  /** Durable peer pair seen from either ordinary side, if any. */
  getPeer(sessionId: string): PeerState | undefined {
    return this.peers.get(sessionId)
  }

  /** Role of one ordinary session inside its pair, if any. */
  peerRole(sessionId: string): 'endeavour' | 'challenger' | undefined {
    return this.peers.roleOf(sessionId)
  }

  /** The other ordinary member of the pair, if the session is paired. */
  peerOfSession(sessionId: string): string | undefined {
    return this.peers.peerOf(sessionId)
  }

  /** All recovered/indexed pairs. */
  peerPairs(): readonly PeerState[] {
    return this.peers.pairs()
  }

  /** Lazily built provisioner over the official host seam (additive). */
  private peerProvisioner(): PeerProvisioner {
    if (this.provisioner === undefined) {
      const seam = createCordisPeerSeam(this.ctx)
      this.provisioner = new PeerProvisioner({
        seam,
        readPair: (sessionId) => this.peers.get(sessionId),
        hasCheckpoint: (sessionId) => this.sessionHasPeerCheckpoint(sessionId),
        appendPair: async (rootSessionId, state, kind, at) => {
          // The SAME validated checkpoint lands on BOTH ordinary logs; the role
          // of each member is derived from its own session id at read time.
          const payload = peerEventPayload(kind, undefined, state, at)
          await this.appendEvent(rootSessionId, PEER_EVENT_TYPE, payload)
          await this.appendEvent(state.challengerSessionId, PEER_EVENT_TYPE, payload)
          this.peers.set(state)
        },
        now: () => Date.now(),
      })
      this.lifecycle = new PeerLifecycle(this.provisioner, { readPair: (sessionId) => this.peers.get(sessionId) })
    }
    return this.provisioner
  }

  /** True when THAT session log carries a validated peer checkpoint. */
  private sessionHasPeerCheckpoint(sessionId: string): boolean {
    const session = this.sessionHost()?.get(sessionId)
    if (session === undefined) return false
    const count = session.seq as unknown as number
    for (let seq = 0; seq < count; seq += 1) {
      const event = session.eventAt(seq as never) as SessionEvent | undefined
      if (event === undefined || event.type !== PEER_EVENT_TYPE) continue
      const state = projectPeerState((event.data as PeerEventPayload | undefined)?.plan)
      if (state !== null && peerRoleOf(state, sessionId) !== undefined) return true
    }
    return false
  }

  /**
   * Ensure the persistent Challenger companion for one ordinary Endeavour
   * session. Idempotent and serialized; never prompts or calls a model.
   */
  async ensurePeer(sessionId: string): Promise<PeerState> {
    return this.peerProvisioner().ensure(sessionId)
  }

  /**
   * Additive lifecycle hook: observe only the CURRENT session so startup
   * recovery never mass-creates peers for cold history. Challenger, Standard
   * and subagent sessions are rejected by the provisioner and swallowed.
   */
  observeCurrentSession(): void {
    const host = this.sessionHost() as unknown as { list?: () => readonly { id: string }[]; current?: () => string | undefined }
    const current = host?.current?.()
    if (typeof current !== 'string' || current === '') return
    this.peerProvisioner()
    this.lifecycle?.observe(current)
  }

  /** Append one checkpoint to its owning root session and flush durability. */
  /**
   * Append + flush one informational checkpoint of any admitted type. Shared
   * by plan checkpoints and (additively) peer checkpoints.
   */
  private async appendEvent(rootSessionId: string, type: string, payload: unknown): Promise<void> {
    const sessions = this.sessionHost()
    const session = sessions?.get(rootSessionId)
    if (session === undefined) {
      throw new EndeavourError('role-forbidden', `root session ${rootSessionId} is not loaded`)
    }
    // Structural append: the admitted type/payload pair is validated by the
    // event-map augmentation, not by the generic overload here.
    const loose = session as unknown as { append(eventType: string, eventData: unknown): void }
    loose.append(type, payload)
    await sessions?.flush(session)
  }

  private async append(rootSessionId: string, kind: PlanEventPayload['kind'], previous: PlanState | undefined, plan: PlanState, at: number): Promise<void> {
    const sessions = this.sessionHost()
    const session = sessions?.get(rootSessionId)
    if (session === undefined) {
      throw new EndeavourError('role-forbidden', `root session ${rootSessionId} is not loaded`)
    }
    void session
    const payload = planEventPayload(kind, previous, plan, at)
    await this.appendEvent(rootSessionId, ENDEAVOUR_EVENT_TYPE, payload)
    this.plans.set(rootSessionId, payload.plan)
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
    return this.enqueue(rootSessionId, async () => {
      if (this.getActivePlan(rootSessionId) !== undefined) {
        throw new EndeavourError('plan-active', 'this Endeavour session already has an active plan')
      }
      const at = Date.now()
      const planId = PlanId(randomUUID())
      const first = input.tasks[0]
      if (first === undefined) throw new EndeavourError('transition-invalid', 'a plan needs at least one task')
      const subagents = this.subagentHost()
      const { options: builderOptions, route: builderRoute } = this.resolveBuilderRoute(agent)
      const started = await subagents.startContinuable({
        provider: this.serviceConfig.builderProvider ?? 'spawn',
        label: 'Builder',
        request: {
          parent: agent,
          prompt: [textBlock(wholePlanBrief(input.title, input.brief, input.constraints, input.tasks))],
          agentOptions: builderOptions,
          persona: this.serviceConfig.builderPersona ?? BUILDER_PROMPT,
          // The Builder must never send ordinary parent messages or delegate:
          // the durable builder_report protocol is its only parent channel.
          // Scoped registrations (builder_start_task/builder_report) are not
          // affected by restrictions, so execution keeps its protocol tools.
          toolFilter: this.serviceConfig.builderToolFilter ?? { deny: [...BUILDER_DEFAULT_DENY] },
          ...(this.serviceConfig.maxDepth === undefined ? {} : { maxDepth: this.serviceConfig.maxDepth }),
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
        builderRoute,
      })
      await this.append(rootSessionId, 'plan-created', undefined, plan, at)
      return { planId: plan.planId, childId, taskCount: plan.tasks.length }
    })
  }

  /** Builder-only: start the current task exactly once, at explicit start time. */
  async builderStartTask(agent: Agent, taskId: string): Promise<PlanState> {
    const childId = agentSessionId(agent)
    if (childId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.getPlanByChild(childId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${childId} is not a plan Builder`)
    return this.enqueue(plan.rootSessionId, async () => {
      const current = this.plans.get(plan.rootSessionId) ?? plan
      assertChildRole(current, childId, agentParentSessionId(agent) ?? current.rootSessionId)
      const at = Date.now()
      const next = startTask(current, TaskId(taskId), at)
      await this.append(current.rootSessionId, 'task-started', current, next, at)
      return next
    })
  }

  /**
   * Builder-only: append the report checkpoint and drive the two-phase flow.
   * Intermediate successful reports send ZERO messages; the final report sends
   * exactly ONE ordered aggregate review request; a blocker/failure sends ONE
   * early review request and stops progression. The public row stays running
   * (Finished) until Endeavour records its verdict.
   */
  async builderReport(agent: Agent, taskId: string, report: BuilderReportInput): Promise<BuilderReportOutcome> {
    const childId = agentSessionId(agent)
    if (childId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.getPlanByChild(childId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${childId} is not a plan Builder`)
    return this.enqueue(plan.rootSessionId, async () => {
      const current = this.plans.get(plan.rootSessionId) ?? plan
      assertChildRole(current, childId, agentParentSessionId(agent) ?? current.rootSessionId)
      const at = Date.now()
      const next = reportTask(current, TaskId(taskId), {
        summary: report.summary,
        files: [...report.files],
        validation: report.validation,
        ...(report.blocker === undefined ? {} : { blocker: report.blocker }),
        ...(report.failure === undefined ? {} : { failure: report.failure }),
      }, at)
      await this.append(current.rootSessionId, 'task-reported', current, next, at)
      const blocked = report.blocker !== undefined || report.failure !== undefined
      const review = blocked || allTasksReported(next)
      if (review) {
        const subagents = this.subagentHost()
        await subagents.sendMessage(agent, current.rootSessionId, [
          textBlock(aggregateReviewRequest(next, blocked)),
        ], { signal: new AbortController().signal })
      }
      if (blocked) return { plan: next, phase: 'blocked' }
      const nextTask = executionCursor(next)?.spec
      return nextTask === undefined
        ? { plan: next, phase: 'review' }
        : { plan: next, phase: 'executing', nextTask }
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
    const plan = this.plans.get(rootSessionId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${rootSessionId} has no plan`)
    return this.enqueue(rootSessionId, async () => {
      const current = this.plans.get(rootSessionId) ?? plan
      assertRootRole(current, rootSessionId)
      const at = Date.now()
      const next = verifyTask(current, TaskId(taskId), outcome, note, at)
      await this.append(rootSessionId, next.terminal === undefined ? 'task-verified' : 'plan-finalized', current, next, at)
      // Ordered verdict only: no child messages, no next dispatch. Later
      // reported rows stay Finished while the review walks the plan in order.
      return next
    })
  }
}

/**
 * Compose the whole-plan Builder prompt: objective, plan constraints, every
 * task in order with its instructions/validation/task constraints, and the
 * exact sequential protocol. Never rendered on the card.
 */
export function wholePlanBrief(
  title: string,
  brief: string,
  constraints: string | undefined,
  tasks: readonly TaskSpec[],
): string {
  const lines: string[] = [
    `Plan: ${title}`,
    'Objective:',
    brief,
  ]
  if (constraints !== undefined && constraints !== '') lines.push(`Plan constraints: ${constraints}`)
  lines.push('', `Ordered tasks (${String(tasks.length)}):`)
  tasks.forEach((task, index) => {
    lines.push(
      `Task ${String(index + 1)} [${task.id}]: ${task.display.title}`,
      'Instructions:',
      task.execution.instructions,
      'Validation criteria:',
      task.execution.validation,
    )
    if (task.execution.constraints !== undefined && task.execution.constraints !== '') {
      lines.push(`Task constraints: ${task.execution.constraints}`)
    }
    lines.push('')
  })
  lines.push(
    'Protocol:',
    'Execute every task sequentially in this order on your own.',
    'Before each task call builder_start_task with its task_id; after finishing it call builder_report with your summary, files, and validation evidence.',
    'After a report continue DIRECTLY with the next task; do not wait for a reply and never send an ordinary message to the parent.',
    'Stop only after the final task has been reported, or immediately when a task has a blocker or failure (later tasks stay waiting).',
    'The parent receives one aggregate review request when all tasks are reported (or immediately on a blocker/failure) and will verify each task in order.',
  )
  return lines.join('\n')
}

/**
 * Tools a Builder must never call: ordinary parent messaging, agent
 * list/interrupt, delegation, background job control, and workflow tools.
 * Coding, filesystem, search, validation, and the scoped builder protocol
 * tools stay available (scoped registrations ignore restrictions).
 */
export const BUILDER_DEFAULT_DENY: readonly string[] = [
  'send_message',
  'list_agents',
  'interrupt_agent',
  'subagent',
  'subagent_fork',
  'job_output',
  'job_list',
  'job_kill',
  'workflow',
  'ralph',
]

/**
 * Compose the detailed single-task brief. Used only for compatibility with a
 * legacy already-active child that knows just its first task: the text is
 * returned in the builder_report tool result after a non-final report.
 */
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

/** Result of one Builder report: the phase the plan moved into. */
export interface BuilderReportOutcome {
  readonly plan: PlanState
  readonly phase: 'executing' | 'review' | 'blocked'
  /** Full next-task brief target while executing (legacy-compatible). */
  readonly nextTask?: TaskSpec
}

/** One aggregate review request covering every reported task in order. */
export function aggregateReviewRequest(plan: PlanState, blocked: boolean): string {
  const lines = [
    blocked
      ? 'Builder reported a blocker/failure and stopped. Review the affected task and record its verdict with endeavour_verify.'
      : `Builder submitted reports for all ${String(plan.tasks.length)} tasks. Review every task in order and call endeavour_verify for each one.`,
    '',
    'Ordered report evidence:',
  ]
  plan.tasks.forEach((task, index) => {
    const report = task.report
    if (report === undefined) {
      lines.push(`${String(index + 1)}. [${task.spec.id}] ${task.spec.display.title} — no report (waiting)`)
      return
    }
    lines.push(
      `${String(index + 1)}. [${task.spec.id}] ${task.spec.display.title}`,
      `   Summary: ${report.summary}`,
      `   Files: ${report.files.join(', ') || 'none'}`,
      `   Validation: ${report.validation}`,
    )
    if (report.blocker !== undefined) lines.push(`   Blocker: ${report.blocker}`)
    if (report.failure !== undefined) lines.push(`   Failure: ${report.failure}`)
  })
  lines.push(
    '',
    'Inspect each report, the workspace, and the evidence, then record one verdict per task in plan order with endeavour_verify. Do not dispatch anything to the Builder.',
  )
  return lines.join('\n')
}

/** Typed report accepted from the model (kept separate from the service input). */
export type { TaskReport }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Endeavour orchestration service provided by this plugin. */
    endeavour: EndeavourService
  }
}
