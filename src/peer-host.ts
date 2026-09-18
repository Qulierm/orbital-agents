/**
 * Narrow injectable seam over the official Host services needed for ordinary
 * peer provisioning and delivery: `ctx.sessionController.create` for ordinary
 * create/adopt (full preset composition and idempotent conflict semantics) and
 * `ctx.sessionController.resolveAgent` for cold-resumed recipient Agents.
 *
 * The project identity is the exact cwd; rc.2 exposes no public workspace
 * grouping API for sessions, so a peer simply appears as an ordinary ungrouped
 * sidebar row (documented fallback) rather than being faked into a group.
 */

import type { PeerRole } from './peer.js'

/** Ordinary session creation result. */
export interface PeerCreateResult {
  readonly sessionId: string
  /** True when the controller adopted an already existing session id. */
  readonly adopted: boolean
}

/** Session metadata the seam exposes (ordinary sessions only). */
export interface PeerSessionMeta {
  readonly id: string
  readonly cwd?: string
  /** Undefined means created outside the subagent driver. */
  readonly origin?: 'subagent'
  readonly agentPreset?: string
}

/** Live-agent delivery face used by the transport. */
export interface PeerAgentFace {
  followup(message: unknown): void
  send(message: unknown, target: 'next-turn' | 'next-step', wakeup: boolean): void
  readonly id?: string
}

/** Ordinary session creation input (blank session: no prompt, no model call). */
export interface PeerCreateInput {
  readonly id: string
  readonly agentPreset: string
  readonly cwd?: string
}

/** Everything provisioning and transport need from the Host. */
export interface PeerHostSeam {
  /** Every known session id (ordinary and otherwise). */
  listSessionIds(): readonly string[]
  /** Metadata for one session, when it exists. */
  sessionMeta(id: string): PeerSessionMeta | undefined
  /**
   * Create or adopt a BLANK ordinary session through the official controller.
   * Never prompts and never starts a model request; an existing id is adopted
   * (the controller owns conflict semantics).
   */
  createOrdinarySession(input: PeerCreateInput): Promise<PeerCreateResult>
  /**
   * Resolve the live Agent for one session, resuming a cold persisted session.
   * Returns undefined only for a real resolution failure.
   */
  resolveAgent(id: string): Promise<PeerAgentFace | undefined>
  /** Copy the model selection from one ordinary session to another, when the
   * deployment exposes a request-free path; undefined means unsupported. */
  copyModelSelection?(fromSessionId: string, toSessionId: string): boolean
}

/** Minimal cordis-shaped surface the adapter reads. */
interface CordisLike {
  get?(name: string): unknown
}

/** ApiSessionAgentResult-shaped resolve outcome. */
type ResolveResult = { readonly agent?: unknown } | { readonly error?: unknown }

interface RawSession {
  readonly id: string
  readonly header?: { readonly cwd?: string; readonly origin?: 'subagent'; readonly agentPreset?: string }
  readonly meta?: { readonly cwd?: string; readonly origin?: 'subagent'; readonly agentPreset?: string }
  /** Live event log access, when the store exposes it. */
  readonly seq?: number
  eventAt?(at: number): { readonly type?: string; readonly data?: unknown } | undefined
}

interface RawSessionsService {
  list?(): readonly RawSession[]
  get?(id: string): RawSession | unknown
  create?(id: string, options?: { meta?: { cwd?: string; agentPreset?: string } }): unknown
  flush?(id?: unknown): unknown
}

interface RawAgentResult {
  readonly agent?: unknown
  readonly error?: unknown
}

/** Official controller surface used by the adapter (official types upstream). */
interface RawController {
  create?(request: { sessionId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId?: string; agentPreset?: string }>
  resolveAgent?(sessionId: string): Promise<ResolveResult>
}

/** Shape of an ApiSessionAgentResult failure, for honest error reporting. */
export interface PeerResolveFailure {
  readonly reason: string
}

/**
 * The session header records the preset a session was CREATED with, but the
 * USER-selected preset is recorded as an `agent-preset/selected` event (the
 * same source the official `agentPreset` projection folds). A user preset that
 * extends a base preset therefore appears as its base in the header and as e.g.
 * `endeavour` in the event, so the event wins whenever it exists.
 */
function selectedPreset(session: RawSession): string | undefined {
  const seq = session.seq
  if (typeof seq !== 'number' || typeof session.eventAt !== 'function') return undefined
  for (let at = seq - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (event === undefined) continue
    if (event.type !== 'agent-preset/selected') continue
    const value = (event.data as { readonly agentPreset?: unknown } | undefined)?.agentPreset
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return undefined
}

function rawMeta(session: RawSession | undefined): PeerSessionMeta | undefined {
  if (session === undefined || session === null) return undefined
  const header = session.header ?? session.meta
  const agentPreset = selectedPreset(session) ?? header?.agentPreset
  return {
    id: session.id,
    ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header?.origin === undefined ? {} : { origin: header.origin }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

/**
 * Adapter over the official services. `ctx.get` follows the upstream pattern so
 * the typed services resolve reliably instead of relying on proxy fields.
 */
export function createCordisPeerSeam(ctx: unknown): PeerHostSeam {
  const get = (ctx as CordisLike).get?.bind(ctx as CordisLike)
  const sessions = get?.('sessions') as RawSessionsService | undefined
  const controller = get?.('sessionController') as RawController | undefined

  if (controller === undefined || typeof controller.create !== 'function' || typeof controller.resolveAgent !== 'function') {
    // Fail loudly at wire-up: silently degrading to a store-less fake would
    // produce peers without composition and delivery without resume.
    throw new Error('dsh-endeavour: sessionController is unavailable; peer provisioning is disabled')
  }

  return {
    listSessionIds: () => (sessions?.list?.() ?? []).map((session) => session.id),
    sessionMeta: (id) => rawMeta(sessions?.get?.(id) as RawSession | undefined),
    createOrdinarySession: async (input) => {
      // Blank ordinary session through the official controller: metadata only,
      // never a prompt and never a model request. An existing id is adopted.
      const value = await controller.create?.({
        sessionId: input.id,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        agentPreset: input.agentPreset,
      })
      const sessionId = value?.sessionId ?? input.id
      return { sessionId, adopted: sessionId !== undefined && sessionId !== input.id ? true : sessionId === input.id }
    },
    resolveAgent: async (id) => {
      const result = await controller.resolveAgent?.(id)
      const agent = (result as RawAgentResult | undefined)?.agent
      if (agent === undefined || agent === null) return undefined
      return agent as PeerAgentFace
    },
  }
}

/** Stable code for a real resolveAgent failure (never used for "not loaded"). */
export function peerResolveFailureReason(result: ResolveResult | undefined): string {
  const error = (result as { error?: unknown } | undefined)?.error
  if (error === undefined) return 'unknown'
  if (typeof error === 'string') return error
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : 'resolve-failed'
}

/** Role-aware helper: the peer id one side must target. */
export function peerTargetFor(pair: { endeavourSessionId: string; challengerSessionId: string }, senderRole: PeerRole): string {
  return senderRole === 'endeavour' ? pair.challengerSessionId : pair.endeavourSessionId
}
