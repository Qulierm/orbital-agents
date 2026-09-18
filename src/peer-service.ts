/**
 * Idempotent, serialized provisioning of the persistent Challenger companion.
 *
 * Creating a peer is a BLANK ordinary session operation: no prompt, no model
 * request, no subagent involvement. The same Endeavour session always resolves
 * to the same deterministic companion, so retries, restarts and concurrent
 * calls converge on one pair.
 */

import {
  challengerSessionIdFor,
  createPeerState,
  PeerError,
  validatePeerState,
  type PeerEventKind,
  type PeerState,
} from './peer.js'
import type { PeerHostSeam, PeerSessionMeta } from './peer-host.js'

/** Injected durable + host dependencies. */
export interface PeerProvisionDeps {
  readonly seam: PeerHostSeam
  /** Durable pair already indexed for either side, if any. */
  readonly readPair: (sessionId: string) => PeerState | undefined
  /**
   * Whether THAT session log already carries a validated peer checkpoint.
   * Presence is tracked per session, not merely by registry indexing, so a
   * one-sided crash is detectable.
   */
  readonly hasCheckpoint: (sessionId: string) => boolean
  /** Append + flush the SAME validated checkpoint to BOTH ordinary logs. */
  readonly appendPair: (rootSessionId: string, state: PeerState, kind: PeerEventKind, at: number) => Promise<void>
  /** Clock (injected for tests). */
  readonly now: () => number
  /** Fail-closed diagnostic sink (started sessions are never rewritten). */
  readonly diagnose?: (message: string) => void
}

/** Serialized provisioner: one in-flight ensure per Endeavour session. */
export class PeerProvisioner {
  private readonly jobs = new Map<string, Promise<PeerState>>()

  constructor(private readonly deps: PeerProvisionDeps) {}

  /** Ensure (and return) the durable pair for one ordinary Endeavour session. */
  ensure(endeavourSessionId: string): Promise<PeerState> {
    const running = this.jobs.get(endeavourSessionId)
    if (running !== undefined) return running
    const job = this.run(endeavourSessionId).finally(() => { this.jobs.delete(endeavourSessionId) })
    this.jobs.set(endeavourSessionId, job)
    return job
  }

  private assertChallenger(meta: PeerSessionMeta | undefined): void {
    if (meta === undefined) throw new PeerError('peer-missing-session', 'challenger session disappeared during provisioning')
    if (meta.origin === 'subagent') throw new PeerError('peer-not-ordinary', `session ${meta.id} is a subagent session`)
    if (meta.agentPreset !== 'challenger') {
      throw new PeerError('peer-conflict', `session ${meta.id} exists with preset ${String(meta.agentPreset)} instead of challenger`)
    }
  }

  private async run(endeavourSessionId: string): Promise<PeerState> {
    const meta = this.deps.seam.sessionMeta(endeavourSessionId)
    if (meta === undefined) throw new PeerError('peer-unknown-session', `unknown session ${endeavourSessionId}`)
    if (meta.origin === 'subagent') throw new PeerError('peer-not-ordinary', `session ${endeavourSessionId} is a subagent session`)
    if (meta.agentPreset !== 'endeavour') {
      throw new PeerError('peer-not-endeavour', `session ${endeavourSessionId} is not an Endeavour session`)
    }
    const at = this.deps.now()
    const challengerSessionId = challengerSessionIdFor(endeavourSessionId)
    // Resolve the owning workspace BEFORE creation so the official controller
    // performs the attach itself (the same path the UI uses).
    const workspaceId = this.deps.seam.workspaceIdFor?.(endeavourSessionId, meta.cwd)
    const existing = this.deps.readPair(endeavourSessionId)
    if (existing !== undefined) {
      const problems = validatePeerState(existing)
      if (problems.length > 0) throw new PeerError('peer-corrupt', problems.join('; '))
      if (existing.endeavourSessionId !== endeavourSessionId || existing.challengerSessionId !== challengerSessionId) {
        throw new PeerError('peer-conflict', 'durable pair does not match the deterministic companion')
      }
      const peerMeta = this.deps.seam.sessionMeta(challengerSessionId)
      if (peerMeta === undefined) {
        // Crash recovery: the mapping survived but the session did not.
        await this.deps.seam.createOrdinarySession({
          id: challengerSessionId,
          agentPreset: 'challenger',
          ...(workspaceId === undefined
            ? (meta.cwd === undefined ? {} : { cwd: meta.cwd })
            : { workspaceId }),
        })
        // The adopted session is live now: heal its composition BEFORE the
        // attachments so a recomposed member is restored on every restart.
        await this.repairMemberPreset(this.deps.seam.sessionMeta(challengerSessionId) ?? { id: challengerSessionId })
        await this.repairAttachments(endeavourSessionId, challengerSessionId, meta.cwd)
        await this.repairPairPolicy(existing)
        // A challenger that is merely NOT LIVE in this process (cold persisted
        // session) is not a lost pair: the ROOT's durable checkpoint is
        // authoritative. Only a root that truly lost its checkpoint is repaired,
        // so repeated launches can never grow the logs.
        if (this.deps.hasCheckpoint(endeavourSessionId)) return existing
        const repaired: PeerState = { ...existing, updatedAt: at, sequence: existing.sequence + 1 }
        await this.deps.appendPair(endeavourSessionId, repaired, 'peer-updated', at)
        return repaired
      }
      // Composition repair runs BEFORE the challenger assertion: a recomposed
      // member still has the challenger header and must be healed, not rejected.
      await this.repairMemberPreset(peerMeta)
      this.assertChallenger(this.deps.seam.sessionMeta(challengerSessionId) ?? peerMeta)
      // Composition repair: a blank pair member whose IMMUTABLE header is the
      // Challenger preset but whose latest selection was recomposed (the blank
      // Hero preset picker could do this) is put back through the official
      // agentPresets.select. Started sessions fail closed with a diagnostic and
      // are NEVER rewritten; arbitrary sessions are never touched.
      // Upgrade repair for pairs created by earlier versions: the ordinary
      // Challenger joins its Endeavour workspace and inherits the Endeavour
      // route ONCE when it has no durable selection of its own. Both steps are
      // idempotent, request-free and never touch an existing selection.
      await this.repairAttachments(endeavourSessionId, challengerSessionId, meta.cwd)
      await this.repairPairPolicy(existing)
      // Reciprocal repair: a crash that committed only one side is healed by
      // re-appending the same validated checkpoint to both logs.
      if (!this.deps.hasCheckpoint(endeavourSessionId) || !this.deps.hasCheckpoint(challengerSessionId)) {
        const repaired: PeerState = { ...existing, updatedAt: at, sequence: existing.sequence + 1 }
        await this.deps.appendPair(endeavourSessionId, repaired, 'peer-updated', at)
        return repaired
      }
      return existing
    }
    const peerMeta = this.deps.seam.sessionMeta(challengerSessionId)
    if (peerMeta !== undefined) this.assertChallenger(peerMeta)
    // Official create/adopt: the controller owns composition and conflict
    // semantics, so an existing challenger is adopted rather than recreated.
    const created = await this.deps.seam.createOrdinarySession({
      id: challengerSessionId,
      agentPreset: 'challenger',
      ...(workspaceId === undefined
        ? (meta.cwd === undefined ? {} : { cwd: meta.cwd })
        : { workspaceId }),
    })
    const state = createPeerState({ endeavourSessionId, at })
    await this.repairPairPolicy(state)
    // Creator-only initial checkpoint: concurrent mounts can all adopt the same
    // deterministic session, and each of them writing `peer-created` would grow
    // the log (observed live: 16 identical checkpoints in one launch). The
    // instance that actually CREATED the session writes it; an adopter re-checks
    // shortly after and only writes when the creator's checkpoint never landed.
    if (created.adopted !== true || this.deps.hasCheckpoint(endeavourSessionId)) {
      await this.deps.appendPair(endeavourSessionId, state, 'peer-created', at)
    } else {
      const timer = setTimeout(() => {
        if (this.deps.hasCheckpoint(endeavourSessionId)) return
        void this.deps.appendPair(endeavourSessionId, state, 'peer-created', this.deps.now()).catch(() => undefined)
      }, 150)
      if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref(): void }).unref()
    }
    await this.repairAttachments(endeavourSessionId, challengerSessionId, meta.cwd)
    return state
  }

  /**
   * Put a pair member back to its frozen preset when the immutable header says
   * `challenger`, the durable pair role is the challenger, the latest SELECTED
   * preset diverged and no turn ever started. Anything else is left untouched;
   * a started mismatch only produces a diagnostic.
   */
  private async repairMemberPreset(peerMeta: PeerSessionMeta): Promise<void> {
    const header = peerMeta.headerAgentPreset
    const selected = peerMeta.selectedAgentPreset
    if (header !== 'challenger' || selected === undefined || selected === 'challenger') return
    if (peerMeta.hasTurnStart === true) {
      this.deps.diagnose?.(`peer preset mismatch on a STARTED session ${peerMeta.id}: header=challenger selected=${selected}; left untouched`)
      return
    }
    try {
      await this.deps.seam.repairPreset?.(peerMeta.id, 'challenger')
      this.deps.diagnose?.(`peer preset repaired on ${peerMeta.id}: ${selected} -> challenger`)
    } catch (error) {
      this.deps.diagnose?.(`peer preset repair failed on ${peerMeta.id}: ${String(error)}`)
    }
  }

  /**
   * Pair policy: the Challenger ALWAYS runs with full host access, and both
   * members carry the pair's `[CODE]` titles. Both operations are idempotent and
   * request-free; failures are diagnosed and retried on the next ensure, so a
   * cosmetic title problem can never destroy a valid pair. The Endeavour side is
   * never given a different permission preset.
   */
  private async repairPairPolicy(pair: PeerState): Promise<void> {
    try {
      await this.deps.seam.ensurePermissionPreset?.(pair.challengerSessionId, 'danger-full-access')
    } catch (error) {
      this.deps.diagnose?.(`challenger permission repair failed on ${pair.challengerSessionId}: ${String(error)}`)
    }
    try {
      await this.deps.seam.ensurePairTitles?.({
        pairId: pair.pairId,
        endeavourSessionId: pair.endeavourSessionId,
        challengerSessionId: pair.challengerSessionId,
      })
    } catch (error) {
      this.deps.diagnose?.(`pair title repair failed on ${pair.pairId}: ${String(error)}`)
    }
  }

  /**
   * Idempotent upgrade repair shared by the create and existing-pair paths:
   * the Challenger must be a member of the Endeavour workspace, and it inherits
   * the Endeavour route ONCE (only while it has no durable selection). Both
   * calls write metadata/selection only — never a prompt or a model request —
   * and every failure keeps the pair alive.
   */
  private async repairAttachments(endeavourSessionId: string, challengerSessionId: string, cwd: string | undefined): Promise<void> {
    try {
      await this.deps.seam.attachToWorkspace?.(challengerSessionId, cwd)
    } catch {
      // An unattached peer is a cosmetic problem; the pair still works.
    }
    try {
      await this.deps.seam.copyModelSelection?.(endeavourSessionId, challengerSessionId)
    } catch {
      // Independent routes remain the safe default.
    }
  }
}

/**
 * Additive lifecycle scheduler: newly seen or resumed Endeavour ordinary
 * sessions schedule an ensure; Challenger, Standard and subagent sessions are
 * ignored, as are sessions that already have a durable pair. Errors are
 * swallowed so a hostile session can never break the host loop.
 */
export class PeerLifecycle {
  private readonly seen = new Set<string>()

  constructor(
    private readonly provisioner: PeerProvisioner,
    private readonly deps: {
      readonly readPair: (sessionId: string) => PeerState | undefined
      /** Live metadata; when provided only ordinary Endeavour sessions qualify. */
      readonly readMeta?: (sessionId: string) => PeerSessionMeta | undefined
      readonly onError?: (error: unknown) => void
    },
  ) {}

  /** Observe one session id; safe to call repeatedly and from HMR re-mounts. */
  observe(sessionId: string): void {
    if (this.seen.has(sessionId)) return
    if (this.deps.readMeta !== undefined) {
      const meta = this.deps.readMeta(sessionId)
      // Ordinary Endeavour sessions only: Standard chats, subagent sessions and
      // the Challenger peer itself are ignored, so observing the peer's own
      // create announcement can never recurse. An unresolvable session is left
      // unseen so a later announcement/list snapshot can retry it.
      if (meta === undefined || meta.origin === 'subagent' || meta.agentPreset !== 'endeavour') return
    }
    this.seen.add(sessionId)
    // Ensured ONCE per observation cycle even when a pair already exists: the
    // provisioner is idempotent and performs the upgrade repairs (workspace
    // membership, one-time route initialization, checkpoint repair) that older
    // pairs need. It never creates a second Challenger or a duplicate
    // checkpoint and never prompts.
    void this.provisioner.ensure(sessionId).catch((error: unknown) => { this.deps.onError?.(error) })
  }

  /** Observe a batch (startup recovery / session list snapshot). */
  observeAll(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.observe(id)
  }
}
