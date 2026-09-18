/**
 * Durable Endeavour orchestration service.
 *
 * One active plan per Endeavour session, executed by its persistent ordinary
 * Challenger peer (historical childId-only plans stay readable). Every mutation
 * appends a whole-value checkpoint event to the owning session log, flushes
 * durability, and is serialized per Endeavour session.
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  PEER_EVENT_TYPE,
  PeerRegistry,
  foldPeerEvents,
  peerEventPayload,
  peerRoleOf,
  type PeerEventPayload,
  type PeerState,
} from './peer.js'
import { createCordisPeerSeam, type PeerHostSeam } from './peer-host.js'
import {
  checkpointOutbox,
  createPeerPlanState,
  deliverOutboxFact,
  deliveryKey,
  planReadyBodyFromPlan,
  planReadyRelay,
  planForChallenger,
  reviewReadyBody,
  reviewReadyRelay,
} from './peer-cutover.js'
import { assertPairedChallenger, assertPairedEndeavour } from './peer-auth.js'
import { aggregateReviewRequest, wholePlanBrief } from './peer-briefs.js'
export { aggregateReviewRequest, wholePlanBrief } from './peer-briefs.js'
import { PeerDeliveryLedger, PeerDeliveryQueue } from './peer-transport.js'
import { projectPeerState } from './peer-projection.js'
import { PeerLifecycle, PeerProvisioner } from './peer-service.js'
import {
  createPlanState,
  EndeavourError,
  foldPlanEvents,
  allTasksReported,
  deliveryFact,
  pendingDeliveries,
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
  /** Canonical persistent Challenger session that received the plan. */
  readonly challengerSessionId: string
  /** @deprecated legacy alias of `challengerSessionId` for older callers. */
  readonly childId?: string
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
  /** Shared FIFO delivery queue + retry ledger for the peer transport. */
  private readonly peerQueue = new PeerDeliveryQueue()
  private readonly peerLedger = new PeerDeliveryLedger()
  private runtimeSeam: PeerHostSeam | undefined
  private provisioner: PeerProvisioner | undefined
  private lifecycle: PeerLifecycle | undefined
  /** Injectable peer runtime (tests) or the lazily built official one. */
  private peerRuntimeDeps: PeerRuntimeDeps | undefined
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly serviceConfig: EndeavourConfig

  constructor(ctx: Context, config: EndeavourConfig = {}) {
    super(ctx, 'endeavour')
    this.serviceConfig = config
    this.recoverExistingPlans()
  }

  /**

  /** The current stored preference, defensively copied. */

  /**
   * Resolve the exact child options once, at plan creation time.
   * - custom: provider/model plus optional effort/maxTokens; the parent's
   *   route-owned effort is intentionally not carried over.
   * - inherit: the Planner's current route through the public upstream
   *   delegation helper.
   */
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

  /** Historical lookup: the legacy plan whose childId matches this session. */
  getPlanByChild(childId: string): PlanState | undefined {
    for (const plan of this.plans.values()) if (plan.childId === childId) return plan
    return undefined
  }

  /** Rebuild in-memory plans from already-loaded root sessions (replay recovery). */
  private recoverExistingPlans(): void {
    const host = this.sessionHost()
    for (const session of host?.list() ?? []) this.adoptSession(session)
    // Outbox reconciliation is opportunistic: pending relays are retried once
    // the runtime is available, and any failure simply stays pending for the
    // next call. It never mutates plan state beyond settling a delivery.
    if ([...this.plans.values()].some((plan) => pendingDeliveries(plan).length > 0)) {
      void this.reconcileOutbox().catch(() => undefined)
    }
  }

  private sessionHost(): SessionHost | undefined {
    return (this.ctx as unknown as { sessions?: SessionHost }).sessions
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
    if (plan !== undefined) {
      const current = this.plans.get(plan.rootSessionId)
      // Re-adoption must never move a live plan backwards: a log re-read can
      // only confirm what the index already holds. The peer registry rejects
      // stale snapshots for the same reason.
      if (current === undefined || current.updatedAt <= plan.updatedAt) this.plans.set(plan.rootSessionId, plan)
    }
    return plan
  }

  /**
   * Adopt the durable plan of a session that attached AFTER the plugin mounted.
   *
   * Desktop mounts the profile before the renderer restores its chats, so the
   * constructor's `recoverExistingPlans` snapshot cannot see them. Without this
   * a restarted Host keeps an in-flight plan unindexed for the rest of the
   * process lifetime, and neither the Challenger report nor the Endeavour
   * verdict can resolve it.
   */
  private adoptAttachedSession(sessionId: string): void {
    const session = this.sessionHost()?.get(sessionId)
    if (session === undefined) return
    const adopted = this.adoptSession(session)
    if (adopted !== undefined && pendingDeliveries(adopted).length > 0) {
      // Same opportunistic reconciliation as mount recovery: a relay that was
      // checkpointed before a crash is retried, and a failure stays pending.
      void this.reconcileOutbox().catch(() => undefined)
    }
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

  /**
   * Install an explicit peer runtime. Tests inject fakes here; production
   * leaves it unset so the official seam/transport is built lazily. This is
   * additive-only for the C2A pass and changes no public plan behavior.
   */
  setPeerRuntime(deps: PeerRuntimeDeps): void {
    this.peerRuntimeDeps = deps
    this.provisioner = deps.provisioner
    this.lifecycle = undefined
  }

  /**
   * Guarantee the persistent Challenger runs with full host access before any
   * plan-ready relay may be delivered. Official PermissionPresetService only
   * (current/set) through the host seam; throws a typed error when the
   * guarantee cannot be made, so callers fail closed and keep the outbox
   * pending instead of starting execution under a downgraded mode.
   */
  private async assertChallengerFullAccess(pair: PeerState): Promise<void> {
    const seam = this.peerRuntime().seam
    if (seam.ensurePermissionPreset === undefined) return
    try {
      await seam.ensurePermissionPreset(pair.challengerSessionId, 'danger-full-access')
    } catch (error) {
      throw new EndeavourError(
        'peer-provision-failed',
        `the Challenger cannot be guaranteed Full access, so plan delivery is withheld: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Full peer runtime: seam, provisioner, FIFO queue and delivery ledger. */
  private peerRuntime(): PeerRuntimeDeps {
    if (this.peerRuntimeDeps !== undefined) return this.peerRuntimeDeps
    const built = this.buildPeerRuntime()
    this.peerRuntimeDeps = built
    return built
  }

  /** Runtime seam/provisioner/queue/ledger accessors for the cutover pass. */
  peerDependencies(): PeerRuntimeDeps {
    return this.peerRuntime()
  }

  /** Outbox runtime view of the peer dependencies (pair reader resolved). */
  private outboxRuntime(): import('./peer-cutover.js').OutboxRuntime {
    const deps = this.peerRuntime()
    return {
      seam: deps.seam,
      queue: deps.queue,
      ledger: deps.ledger,
      readPair: deps.readPair ?? ((sessionId: string) => this.peers.get(sessionId)),
    }
  }

  /** Lazily built provisioner over the official host seam (additive). */
  private peerProvisioner(): PeerProvisioner {
    if (this.provisioner === undefined) {
      const seam = createCordisPeerSeam(this.ctx)
      this.runtimeSeam = seam
      this.provisioner = new PeerProvisioner({
        seam,
        readPair: (sessionId) => this.peers.get(sessionId) ?? this.latestDurablePair(sessionId),
        hasCheckpoint: (sessionId) => this.sessionHasPeerCheckpoint(sessionId),
        diagnose: (message) => {
          const logger = (this.ctx as unknown as { logger?: { warn?(message: string): void } }).logger
          logger?.warn?.(`dsh-endeavour: ${message}`)
          // A repair diagnostic must be visible even when the host logger is
          // not wired to the console (fail-closed transparency).
          console.warn(`dsh-endeavour: ${message}`)
        },
        appendPair: async (rootSessionId, state, kind, at) => {
          // The SAME validated checkpoint lands on BOTH ordinary logs; the role
          // of each member is derived from its own session id at read time.
          // Each side is appended AT MOST ONCE per (pairId, sequence): a
          // re-mount/repair race can never duplicate a checkpoint, and a side
          // that already carries it is never rewritten.
          const payload = peerEventPayload(kind, undefined, state, at)
          if (!this.sessionHasPeerCheckpoint(rootSessionId, state)) {
            await this.appendEvent(rootSessionId, PEER_EVENT_TYPE, payload)
          }
          if (!this.sessionHasPeerCheckpoint(state.challengerSessionId, state)) {
            await this.appendEvent(state.challengerSessionId, PEER_EVENT_TYPE, payload)
          }
          this.peers.set(state)
        },
        now: () => Date.now(),
      })
      this.lifecycle = new PeerLifecycle(this.provisioner, {
        readPair: (sessionId) => this.peers.get(sessionId) ?? this.latestDurablePair(sessionId),
        readMeta: (sessionId) => seam.sessionMeta(sessionId),
      })
    }
    return this.provisioner
  }

  /**
   * True when THAT session log carries a peer checkpoint. With `state` given it
   * is true only for the SAME pair and sequence, so an append is skipped when
   * the checkpoint is already durably present.
   */
  private sessionHasPeerCheckpoint(sessionId: string, state?: PeerState): boolean {
    const checkpoint = this.latestDurablePair(sessionId)
    if (checkpoint === undefined) return false
    if (state === undefined) return true
    // Same pair AND same sequence: this exact checkpoint is already durable.
    return checkpoint.pairId === state.pairId && checkpoint.sequence === state.sequence
  }

  /**
   * The LATEST validated peer checkpoint recorded in THAT session's own log
   * (member-checked), so a restart can repair an existing pair without any
   * registry state.
   */
  private latestDurablePair(sessionId: string): PeerState | undefined {
    const session = this.sessionHost()?.get(sessionId)
    if (session === undefined) return undefined
    const count = session.seq as unknown as number
    for (let seq = count - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq as never) as SessionEvent | undefined
      if (event === undefined || event.type !== PEER_EVENT_TYPE) continue
      const checkpoint = projectPeerState((event.data as PeerEventPayload | undefined)?.plan)
      if (checkpoint !== null && peerRoleOf(checkpoint, sessionId) !== undefined) return checkpoint
    }
    return undefined
  }

  /**
   * Ensure the persistent Challenger companion for one ordinary Endeavour
   * session. Idempotent and serialized; never prompts or calls a model.
   */
  async ensurePeer(sessionId: string): Promise<PeerState> {
    return this.peerProvisioner().ensure(sessionId)
  }

  /** Build the official runtime seam/provisioner/queue/ledger once. */
  private buildPeerRuntime(): PeerRuntimeDeps {
    if (this.provisioner === undefined) this.peerProvisioner()
    const seam = this.runtimeSeam
    if (seam === undefined || this.provisioner === undefined) {
      throw new EndeavourError('role-forbidden', 'peer runtime is unavailable in this deployment')
    }
    const runtime: PeerRuntimeDeps = {
      seam,
      provisioner: this.provisioner,
      queue: this.peerQueue,
      ledger: this.peerLedger,
    }
    return runtime
  }

  /**
   * Correct Host lifecycle wiring for plan recovery and peer provisioning.
   *
   * 1. Every session that is ALREADY ATTACHED at mount time (`sessions.list()`,
   *    i.e. live entries only — never cold persisted history) is observed once.
   * 2. `session/created` announcements observe NEWLY created or resumed
   *    sessions as they attach, so a restarted Host recovers an in-flight plan
   *    as soon as the renderer restores its chat, and a Challenger exists as
   *    soon as its Endeavour session exists, without waiting for
   *    `endeavour_plan`.
   *
   * Eligibility (ordinary, preset `endeavour`, no subagent origin and no
   * existing pair) lives in `PeerLifecycle`, so Standard chats, subagent
   * sessions and the Challenger's own creation announcement are ignored and can
   * never recurse. Plan adoption runs for every announced session: a session
   * without `endeavour/plan` events folds to nothing and costs one log read.
   * Returns a disposer that unsubscribes for HMR/unmount.
   */
  observeSessionLifecycle(): () => void {
    const events = this.ctx as unknown as {
      on?: (name: string, listener: (...args: unknown[]) => void) => (() => void) | undefined
    }
    const observe = (sessionId: string): void => {
      this.adoptAttachedSession(sessionId)
      this.lifecycle?.observe(sessionId)
    }
    const offCreated = events.on?.('session/created', (session: unknown) => {
      const id = (session as { readonly id?: unknown } | undefined)?.id
      if (typeof id === 'string' && id !== '') observe(id)
    })
    // A session created as Standard is announced BEFORE its preset is selected,
    // so the creation observation is correctly ignored by the peer lifecycle.
    // The official `agent-preset/selected` event (sessionId, preset) is the
    // moment a session BECOMES an Endeavour session: observe that exact session
    // then. The durable selection event has already been appended when this
    // fires, so the metadata read sees the new preset without relying on the
    // immutable header.
    const offSelected = events.on?.('agent-preset/selected', (sessionId: unknown, preset: unknown) => {
      if (preset !== 'endeavour') return
      if (typeof sessionId !== 'string' || sessionId === '') return
      observe(sessionId)
    })
    try {
      const runtime = this.peerRuntime()
      const lifecycle = this.lifecycle ?? new PeerLifecycle(runtime.provisioner, {
        readPair: (sessionId) => this.peers.get(sessionId) ?? this.latestDurablePair(sessionId),
        readMeta: (sessionId) => {
          try {
            return runtime.seam.sessionMeta(sessionId)
          } catch {
            return undefined
          }
        },
        onError: () => {},
      })
      this.lifecycle = lifecycle
      for (const sessionId of runtime.seam.listSessionIds()) observe(sessionId)
    } catch {
      // Peer provisioning is additive; a missing host seam must not break plans.
      // Plan adoption above is independent of it and stays subscribed.
    }
    return () => {
      if (typeof offCreated === 'function') offCreated()
      if (typeof offSelected === 'function') offSelected()
    }
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
   * Create the single active plan and deliver the whole plan to the persistent
   * Challenger peer. The caller must be the paired Endeavour side; this method
   * NEVER creates an agent, never starts a subagent, and never prompts a model
   * directly (the relay is the only wakeup).
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
      // Defense in depth: a genuine ordinary Endeavour caller whose pair was not
      // indexed yet (the creation race) provisions BEFORE authorization, so the
      // first plan can never fail with "session is not part of a durable pair".
      // Non-Endeavour callers never provision: they fall through to the exact
      // authorization below and are rejected without touching the Host.
      if (this.peers.get(rootSessionId) === undefined) {
        // A deployment without the host seam keeps the previous behavior: the
        // authorization below reports the typed pair error.
        let meta: { readonly origin?: 'subagent'; readonly agentPreset?: string } | undefined
        try {
          meta = this.peerRuntime().seam.sessionMeta(rootSessionId)
        } catch {
          meta = undefined
        }
        if (meta !== undefined && meta.origin !== 'subagent' && meta.agentPreset === 'endeavour') {
          try {
            this.peers.set(await this.peerRuntime().provisioner.ensure(rootSessionId))
          } catch (error) {
            throw new EndeavourError(
              'peer-provision-failed',
              `could not provision the persistent Challenger for ${rootSessionId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }
      const pair = assertPairedEndeavour(this.peers.get(rootSessionId), rootSessionId, undefined).pair
      if (this.getActivePlan(rootSessionId) !== undefined) {
        throw new EndeavourError('plan-active', 'this Endeavour session already has an active plan')
      }
      const at = Date.now()
      const planId = PlanId(randomUUID())
      if (input.tasks.length === 0) throw new EndeavourError('transition-invalid', 'a plan needs at least one task')
      // Provision (or adopt) the persistent ordinary Challenger: idempotent,
      // blank, and never a model request.
      const ensured = await this.peerRuntime().provisioner.ensure(rootSessionId)
      let plan = createPeerPlanState({
        planId,
        pair: ensured,
        title: input.title,
        tasks: input.tasks,
        at,
        brief: input.brief,
        ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
      })
      await this.append(rootSessionId, 'plan-created', undefined, plan, at)
      // Durable outbox: checkpoint the relay BEFORE any transport attempt so a
      // crash between the checkpoint and the delivery can be reconciled.
      const relay = planReadyRelay(ensured, plan, planReadyBodyFromPlan(plan))
      plan = checkpointOutbox(plan, relay, at)
      await this.append(rootSessionId, 'delivery-pending', this.plans.get(rootSessionId), plan, at)
      const fact = deliveryFact(plan, deliveryKey(relay.pairId, plan.planId, relay.messageKind))
      if (fact !== undefined) {
        // Fail closed: execution may not start unless the Challenger is
        // guaranteed Full access. The relay stays pending when this throws.
        if (relay.messageKind === 'plan-ready') await this.assertChallengerFullAccess(ensured)
        try {
          const outcome = await deliverOutboxFact(this.outboxRuntime(), plan, relay, fact)
          plan = outcome.plan
          if (outcome.delivered) {
            await this.append(rootSessionId, 'delivery-settled', this.plans.get(rootSessionId), plan, Date.now())
          }
        } catch {
          // The relay stays PENDING and retryable; plan creation already
          // succeeded durably and reconcileOutbox delivers later.
        }
      }
      return { planId: plan.planId, challengerSessionId: ensured.challengerSessionId, taskCount: plan.tasks.length }
    })
  }

  /** Challenger-only: start the current execution item exactly once. */
  async challengerStartTask(agent: Agent, taskId: string): Promise<PlanState> {
    const callerId = agentSessionId(agent)
    if (callerId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = planForChallenger(this.plans.values(), callerId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${callerId} is not the Challenger of an active plan`)
    assertPairedChallenger(this.peers.get(callerId), callerId, plan)
    return this.enqueue(plan.rootSessionId, async () => {
      const current = this.plans.get(plan.rootSessionId) ?? plan
      assertPairedChallenger(this.peers.get(callerId), callerId, current)
      const at = Date.now()
      const next = startTask(current, TaskId(taskId), at)
      await this.append(current.rootSessionId, 'task-started', current, next, at)
      return next
    })
  }

  /**
   * Challenger-only: append the report checkpoint and drive the two-phase flow.
   * Intermediate successful reports relay NOTHING; the final report (or an
   * early blocker/failure) checkpoints exactly ONE review-ready outbox fact and
   * delivers the ordered aggregate to the paired Endeavour. The public row
   * stays running (Finished) until Endeavour records its verdict.
   */
  async challengerReport(agent: Agent, taskId: string, report: BuilderReportInput): Promise<BuilderReportOutcome> {
    const callerId = agentSessionId(agent)
    if (callerId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = planForChallenger(this.plans.values(), callerId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${callerId} is not the Challenger of an active plan`)
    assertPairedChallenger(this.peers.get(callerId), callerId, plan)
    return this.enqueue(plan.rootSessionId, async () => {
      const current = this.plans.get(plan.rootSessionId) ?? plan
      const pair = assertPairedChallenger(this.peers.get(callerId), callerId, current).pair
      const at = Date.now()
      let next = reportTask(current, TaskId(taskId), {
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
        const relay = reviewReadyRelay(pair, next, reviewReadyBody(next, blocked))
        next = checkpointOutbox(next, relay, at)
        await this.append(next.rootSessionId, 'delivery-pending', this.plans.get(next.rootSessionId), next, at)
        const fact = deliveryFact(next, deliveryKey(relay.pairId, next.planId, relay.messageKind))
        if (fact !== undefined) {
          try {
            const outcome = await deliverOutboxFact(this.outboxRuntime(), next, relay, fact)
            next = outcome.plan
            if (outcome.delivered) {
              await this.append(next.rootSessionId, 'delivery-settled', this.plans.get(next.rootSessionId), next, Date.now())
            }
          } catch {
            // Pending fact: reconcileOutbox retries without duplicating state.
          }
        }
      }
      if (blocked) return { plan: next, phase: 'blocked' }
      const nextTask = executionCursor(next)?.spec
      return nextTask === undefined
        ? { plan: next, phase: 'review' }
        : { plan: next, phase: 'executing', nextTask }
    })
  }

  /**
   * Endeavour-only ordered verification. Freezes the duration and finalizes on
   * the last success or any failure; it NEVER relays anything back.
   */
  async verifyTask(agent: Agent, taskId: string, outcome: 'succeeded' | 'failed', note?: string): Promise<PlanState> {
    const rootSessionId = agentSessionId(agent)
    if (rootSessionId === undefined) throw new EndeavourError('role-forbidden', 'calling agent has no session id')
    const plan = this.plans.get(rootSessionId)
    if (plan === undefined) throw new EndeavourError('role-forbidden', `session ${rootSessionId} has no plan`)
    assertPairedEndeavour(this.peers.get(rootSessionId), rootSessionId, plan)
    return this.enqueue(rootSessionId, async () => {
      const current = this.plans.get(rootSessionId) ?? plan
      assertPairedEndeavour(this.peers.get(rootSessionId), rootSessionId, current)
      const at = Date.now()
      const next = verifyTask(current, TaskId(taskId), outcome, note, at)
      await this.append(rootSessionId, next.terminal === undefined ? 'task-verified' : 'plan-finalized', current, next, at)
      return next
    })
  }

  /**
   * Restart/outbox reconciliation: rebuild every pending relay from durable
   * state (plan-ready from the private brief fields, review-ready from the task
   * reports) and re-deliver idempotently. Delivered facts are ignored; failures
   * stay pending and retryable. Safe to call repeatedly and concurrently.
   */
  async reconcileOutbox(): Promise<number> {
    let delivered = 0
    for (const indexed of [...this.plans.values()]) {
      if (indexed.pairId === undefined) continue
      for (const fact of pendingDeliveries(indexed)) {
        const ok = await this.enqueue(indexed.rootSessionId, async () => {
          const current = this.plans.get(indexed.rootSessionId)
          if (current === undefined) return false
          const currentFact = deliveryFact(current, fact.key)
          if (currentFact === undefined || currentFact.status === 'delivered') return false
          const pair = this.peers.get(current.rootSessionId)
          if (pair === undefined) return false
          const relay = currentFact.kind === 'plan-ready'
            ? planReadyRelay(pair, current, planReadyBodyFromPlan(current))
            : reviewReadyRelay(pair, current, reviewReadyBody(current, firstBlockedReport(current) !== undefined))
          if (currentFact.kind === 'plan-ready') {
            try {
              await this.assertChallengerFullAccess(pair)
            } catch {
              // Keep the fact PENDING: reconcileOutbox retries after repair.
              return false
            }
          }
          const outcome = await deliverOutboxFact(this.outboxRuntime(), current, relay, currentFact)
          if (!outcome.delivered) return false
          await this.append(outcome.plan.rootSessionId, 'delivery-settled', current, outcome.plan, Date.now())
          return true
        })
        if (ok) delivered += 1
      }
    }
    return delivered
  }

}

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

/** Peer runtime dependencies the C2B cutover consumes (injectable for tests). */
export interface PeerRuntimeDeps {
  readonly seam: PeerHostSeam
  readonly provisioner: PeerProvisioner
  readonly queue: PeerDeliveryQueue
  readonly ledger: PeerDeliveryLedger
  /** Pair lookup used by the outbox; defaults to the service registry. */
  readonly readPair?: (sessionId: string) => PeerState | undefined
}

/** Typed report accepted from the model (kept separate from the service input). */
export type { TaskReport }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Endeavour orchestration service provided by this plugin. */
    endeavour: EndeavourService
  }
}
