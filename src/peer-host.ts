/**
 * Narrow injectable seam over the official Host services needed for ordinary
 * peer provisioning and delivery: session create/adopt metadata, recipient
 * Agent resolution, and workspace association.
 *
 * Only official APIs are used (`ctx.sessions` SessionStore.create and
 * `ctx.agents` AgentRegistry.get); no subagent imports appear here, and tests
 * drive the interface with fakes instead of real sessions.
 */

import type { PeerRole } from './peer.js'

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
   * Create a BLANK ordinary session. Implementations must never prompt or start
   * a model request; an existing id is adopted instead of recreated.
   */
  createOrdinarySession(input: PeerCreateInput): void
  /** Resolve the live Agent for one session, when it is attached. */
  resolveAgent(id: string): PeerAgentFace | undefined
  /** Public workspace grouping for one session, when the registry exposes it. */
  workspaceOf(sessionId: string): string | undefined
  /** Copy the model selection from one ordinary session to another, when the
   * deployment exposes a request-free path; undefined means unsupported. */
  copyModelSelection?(fromSessionId: string, toSessionId: string): boolean
}

/** Minimal cordis-shaped surface the adapter reads. */
interface CordisLike {
  get?(name: string): unknown
}

interface RawSession {
  readonly id: string
  readonly header?: { readonly cwd?: string; readonly origin?: 'subagent'; readonly agentPreset?: string }
  readonly meta?: { readonly cwd?: string; readonly origin?: 'subagent'; readonly agentPreset?: string }
}

interface RawSessionsService {
  list?(): readonly RawSession[]
  get?(id: string): RawSession | unknown
  create?(id: string, options?: { meta?: { cwd?: string; agentPreset?: string } }): unknown
  flush?(id?: unknown): unknown
}

interface RawAgentsService {
  get?(id: string): unknown
}

function rawMeta(session: RawSession | undefined): PeerSessionMeta | undefined {
  if (session === undefined || session === null) return undefined
  const header = session.header ?? session.meta
  return {
    id: session.id,
    ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header?.origin === undefined ? {} : { origin: header.origin }),
    ...(header?.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  }
}

/**
 * Adapter over the official services. `ctx.get` follows the upstream pattern so
 * the typed services resolve reliably instead of relying on proxy fields.
 */
export function createCordisPeerSeam(ctx: unknown): PeerHostSeam {
  const get = (ctx as CordisLike).get?.bind(ctx as CordisLike)
  const sessions = get?.('sessions') as RawSessionsService | undefined
  const agents = get?.('agents') as RawAgentsService | undefined
  const workspaces = get?.('uiWorkspace') as { workspaceOf?(id: string): string | undefined } | undefined

  return {
    listSessionIds: () => (sessions?.list?.() ?? []).map((session) => session.id),
    sessionMeta: (id) => rawMeta(sessions?.get?.(id) as RawSession | undefined),
    createOrdinarySession: (input) => {
      // Blank ordinary session: metadata only, never a prompt or model request.
      sessions?.create?.(input.id, {
        meta: {
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          agentPreset: input.agentPreset,
        },
      })
    },
    resolveAgent: (id) => agents?.get?.(id) as PeerAgentFace | undefined,
    workspaceOf: (id) => workspaces?.workspaceOf?.(id),
  }
}

/** Role-aware helper: the peer id one side must target. */
export function peerTargetFor(pair: { endeavourSessionId: string; challengerSessionId: string }, senderRole: PeerRole): string {
  return senderRole === 'endeavour' ? pair.challengerSessionId : pair.endeavourSessionId
}
