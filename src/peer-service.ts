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
          ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
        })
        const repaired: PeerState = { ...existing, updatedAt: at, sequence: existing.sequence + 1 }
        await this.deps.appendPair(endeavourSessionId, repaired, 'peer-updated', at)
        return repaired
      }
      this.assertChallenger(peerMeta)
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
    await this.deps.seam.createOrdinarySession({
      id: challengerSessionId,
      agentPreset: 'challenger',
      ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
    })
    const state = createPeerState({ endeavourSessionId, at })
    await this.deps.appendPair(endeavourSessionId, state, 'peer-created', at)
    // One-time route copy only where the deployment exposes a request-free path;
    // afterwards the two ordinary sessions keep independent routes.
    if (this.deps.seam.copyModelSelection !== undefined) {
      try {
        this.deps.seam.copyModelSelection(endeavourSessionId, challengerSessionId)
      } catch {
        // Independent routes remain the safe default.
      }
    }
    return state
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
    private readonly deps: { readonly readPair: (sessionId: string) => PeerState | undefined; readonly onError?: (error: unknown) => void },
  ) {}

  /** Observe one session id; safe to call repeatedly and from HMR re-mounts. */
  observe(sessionId: string): void {
    if (this.seen.has(sessionId)) return
    this.seen.add(sessionId)
    if (this.deps.readPair(sessionId) !== undefined) return
    void this.provisioner.ensure(sessionId).catch((error: unknown) => { this.deps.onError?.(error) })
  }

  /** Observe a batch (startup recovery / session list snapshot). */
  observeAll(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.observe(id)
  }
}
