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
  /** Owning workspace, when the Host can resolve one for the Endeavour session. */
  readonly workspaceId?: string
}

/** One ordinary-session model selection as the Host projects it. */
export interface PeerModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
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
  /**
   * Owning workspace id for a session: membership first, then the canonical
   * workspace path matching the session cwd. Undefined when unknown.
   */
  workspaceIdFor?(sessionId: string, cwd?: string): string | undefined
  /**
   * Attach a session to its owning workspace (idempotent: an existing member is
   * left untouched). Undefined means the deployment exposes no registry.
   */
  attachToWorkspace?(sessionId: string, cwd?: string): Promise<void>
  /**
   * The session's own durable model selection, read from the official
   * projection. Undefined when the session never selected anything.
   */
  selectionOf?(sessionId: string): PeerModelSelection | undefined
  /**
   * Write one validated selection with the official controller. Writes only the
   * selection for the next request; never starts a model request.
   */
  selectModel?(sessionId: string, selection: PeerModelSelection): Promise<void>
  /**
   * One-time route initialization: when the TARGET session has no durable
   * selection, copy the SOURCE session's current selection through the official
   * controller. Never overwrites an existing selection. Undefined means
   * unsupported.
   */
  copyModelSelection?(fromSessionId: string, toSessionId: string): Promise<void>
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
  create?(request: { sessionId?: string; cwd?: string; agentPreset?: string; workspaceId?: string }): Promise<{ sessionId?: string; agentPreset?: string }>
  selectModel?(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>
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

/** Minimal workspace shape read from the official registry. */
interface RawWorkspace {
  readonly id: string
  readonly path?: string
  readonly sessionIds?: readonly string[]
}

interface RawWorkspaceRegistry {
  list?(): readonly RawWorkspace[]
  get?(id: string): RawWorkspace | undefined
}

/** Read-and-validate one selection record (durable event payload). */
function projectedSelection(value: unknown): PeerModelSelection | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
  if (typeof record.provider !== 'string' || record.provider === '') return undefined
  if (typeof record.model !== 'string' || record.model === '') return undefined
  return {
    provider: record.provider,
    model: record.model,
    ...(typeof record.reasoningEffort === 'string' && record.reasoningEffort !== ''
      ? { reasoningEffort: record.reasoningEffort }
      : {}),
  }
}

/**
 * The session's own durable selection, read from the SAME events the official
 * `modelSelection` projection folds: the latest `model/selection` wins, and a
 * request header is the fallback (a header effort the adapter defaulted is not
 * a conversation choice and is dropped, exactly like the projection does).
 */
function durableSelection(session: RawSession): PeerModelSelection | undefined {
  const seq = session.seq
  if (typeof seq !== 'number' || typeof session.eventAt !== 'function') return undefined
  for (let at = seq - 1; at >= 0; at -= 1) {
    const event = session.eventAt(at)
    if (event === undefined) continue
    if (event.type === 'model/selection') {
      const selected = projectedSelection(event.data)
      if (selected !== undefined) return selected
      continue
    }
    if (event.type !== 'request/header') continue
    const header = (event.data as { readonly header?: { readonly config?: unknown; readonly adapterDefaults?: { readonly reasoningEffort?: unknown } } } | undefined)?.header
    const config = projectedSelection(header?.config)
    if (config === undefined) continue
    if (header?.adapterDefaults?.reasoningEffort === true && config.reasoningEffort !== undefined) {
      return { provider: config.provider, model: config.model }
    }
    return config
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

  const workspaces = get?.('workspaceRegistry') as RawWorkspaceRegistry | undefined

  /**
   * Owning workspace for a session: live membership first (authoritative), then
   * the canonical registry path matching the session's cwd.
   */
  const workspaceOf = (sessionId: string, cwd?: string): RawWorkspace | undefined => {
    const all = workspaces?.list?.() ?? []
    const member = all.find((workspace) => workspace.sessionIds?.includes(sessionId) === true)
    if (member !== undefined) return member
    if (cwd === undefined || cwd === '') return undefined
    return all.find((workspace) => workspace.path !== undefined && workspace.path === cwd)
  }

  /** Read one session's durable selection from its own committed events. */
  const selectionOf = (sessionId: string): PeerModelSelection | undefined => {
    const session = sessions?.get?.(sessionId) as RawSession | undefined
    if (session === undefined) return undefined
    return durableSelection(session)
  }

  return {
    listSessionIds: () => (sessions?.list?.() ?? []).map((session) => session.id),
    sessionMeta: (id) => rawMeta(sessions?.get?.(id) as RawSession | undefined),
    createOrdinarySession: async (input) => {
      // Blank ordinary session through the official controller: metadata only,
      // never a prompt and never a model request. An existing id is adopted.
      // A known workspace is passed so the controller performs the official
      // attach itself (the same path the UI uses).
      // The controller accepts a workspaceId OR a cwd, never both: a workspace
      // implies its canonical path, so the id wins when known.
      const value = await controller.create?.({
        sessionId: input.id,
        ...(input.workspaceId === undefined
          ? (input.cwd === undefined ? {} : { cwd: input.cwd })
          : { workspaceId: input.workspaceId }),
        agentPreset: input.agentPreset,
      })
      const sessionId = value?.sessionId ?? input.id
      return { sessionId, adopted: sessionId !== undefined && sessionId !== input.id ? true : sessionId === input.id }
    },
    workspaceIdFor: (sessionId, cwd) => workspaceOf(sessionId, cwd)?.id,
    attachToWorkspace: async (sessionId, cwd) => {
      const workspace = workspaceOf(sessionId, cwd)
      if (workspace === undefined) return
      // Idempotent: an existing member is never re-attached.
      if (workspace.sessionIds?.includes(sessionId) === true) return
      const entity = workspaces?.get?.(workspace.id) as (RawWorkspace & { attachSession?(id: string): Promise<void> }) | undefined
      if (typeof entity?.attachSession !== 'function') return
      await entity.attachSession(sessionId)
    },
    selectionOf,
    selectModel: async (sessionId, selection) => {
      if (typeof controller.selectModel !== 'function') return
      await controller.selectModel({
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      })
    },
    copyModelSelection: async (fromSessionId, toSessionId) => {
      // NEVER overwrite what the Challenger already chose.
      const target = selectionOf(toSessionId)
      if (target !== undefined) return
      const source = selectionOf(fromSessionId)
      if (source === undefined) return
      await controller.selectModel?.({
        sessionId: toSessionId,
        provider: source.provider,
        model: source.model,
        ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
      })
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
