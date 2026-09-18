/**
 * Peer activity as legitimate Conversation content.
 *
 * A deterministic pair member is an ordinary session with NO turns, so rc.2
 * renders the blank Hero and hides the native header/View ring. This module
 * turns the durable `endeavour/peer` checkpoint — already present in BOTH logs —
 * into registered Conversation activity:
 *
 * 1. a ConversationNodeDefinition folds the checkpoint into a node of the
 *    plugin-owned `endeavour-peer` view target (deterministic from replay, no
 *    synthetic turn, message or prompt);
 * 2. a ConversationViewDefinition classifies that target as ACTIVE whenever the
 *    checkpoint exists, so `conversationPhase` becomes `active` for the session.
 *
 * The target owns no presentation entry, so nothing extra is drawn: the effect
 * is that the native header and the Chat/Trajectory/<peer> strip render for
 * both halves of the pair immediately after provisioning.
 */

import type {
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationViewBuilder,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PeerEventPayload, PeerState } from '../peer.js'

/** Plugin-owned Conversation view target that carries peer activity. */
export const PEER_ACTIVITY_TARGET = 'endeavour-peer'

/** Node kind folded from the durable checkpoint. */
export const PEER_ACTIVITY_KIND = 'endeavour-peer'

/** Activity snapshot consumed by the shell phase. */
export interface PeerActivitySnapshot {
  /** True while this session carries at least one durable peer checkpoint. */
  readonly paired: boolean
}

/** One peer checkpoint node (no presentation entry is registered for it). */
export interface PeerActivityNode {
  readonly key: string
  readonly kind: typeof PEER_ACTIVITY_KIND
  readonly id: string
  readonly target: typeof PEER_ACTIVITY_TARGET
  readonly anchorSeq: number
  readonly location: unknown
  readonly visibility: 'visible'
  readonly data: PeerActivitySnapshot
}

function isPeerState(value: unknown): value is PeerState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Partial<PeerState>
  return typeof state.pairId === 'string'
    && typeof state.endeavourSessionId === 'string'
    && typeof state.challengerSessionId === 'string'
}

function eventPeer(event: { readonly type: string; readonly data: unknown }): PeerState | null {
  if (event.type !== 'endeavour/peer') return null
  const payload = event.data as Partial<PeerEventPayload>
  return isPeerState(payload?.plan) ? payload.plan : null
}

/** Durable `endeavour/peer` family folded into one activity node per pair. */
export const endeavourPeerNodeDefinition: ConversationNodeDefinition<PeerState> = {
  kind: PEER_ACTIVITY_KIND,
  target: PEER_ACTIVITY_TARGET,
  match: (event) => {
    const state = eventPeer(event)
    if (state === null) return null
    const payload = (event as { readonly data?: Partial<PeerEventPayload> }).data
    return { id: state.pairId, role: payload?.kind === 'peer-created' ? 'start' : 'update' }
  },
  start: (_context, match) => {
    const state = eventPeer(match.event)
    if (state === null) throw new Error('endeavour-peer start requires an endeavour/peer event')
    return state
  },
  update: (context: ConversationNodeContext<PeerState> & { readonly state: PeerState }, match: ConversationMatch) => {
    const state = eventPeer(match.event)
    // Whole-value checkpoints: the newest sequence wins, stale replays are ignored.
    return state === null || state.sequence < context.state.sequence ? context.state : state
  },
  buildViewNode: (context): PeerActivityNode | null => {
    if (context.start === undefined || context.state === undefined) return null
    return {
      key: context.key,
      kind: PEER_ACTIVITY_KIND,
      id: context.id,
      target: PEER_ACTIVITY_TARGET,
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: { paired: true },
    }
  },
}

/** Incremental builder: `paired` is exactly "at least one checkpoint node". */
class PeerActivityBuilder implements ConversationViewBuilder<PeerActivityNode, PeerActivitySnapshot> {
  readonly empty: PeerActivitySnapshot = { paired: false }
  private keys = new Set<string>()

  replace(input: { readonly nodes: readonly PeerActivityNode[] }): PeerActivitySnapshot {
    this.keys = new Set(input.nodes.map((node) => node.key))
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly PeerActivityNode[] }): PeerActivitySnapshot {
    for (const node of input.upserts) this.keys.add(node.key)
    return this.snapshot()
  }

  private snapshot(): PeerActivitySnapshot {
    return { paired: this.keys.size > 0 }
  }
}

/** View definition that classifies peer activity as visible Conversation content. */
export const endeavourPeerViewDefinition: ConversationViewDefinition<PeerActivityNode, PeerActivitySnapshot> = {
  target: PEER_ACTIVITY_TARGET,
  create: () => new PeerActivityBuilder(),
  isActive: (snapshot) => snapshot.paired === true,
}
