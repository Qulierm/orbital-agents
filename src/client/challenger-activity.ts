/**
 * Live Challenger activity for an active plan.
 *
 * The durable plan only knows what the protocol recorded; whether the paired
 * Challenger is executing right now is a property of the official Session
 * Controller list snapshot (`phase` plus `byId[sessionId].running`), which every
 * session-scoped slot receives as the standard `useSessions` hook. This module
 * turns those two facts into one plain value so the plan surfaces can mark a
 * stopped Challenger without inventing durable state, events, polling or
 * timers.
 */

import type { EndeavourCardData } from '../plan-projection.js'

/** Minimal structural view of the official session list snapshot. */
export interface SessionActivityLike {
  readonly phase?: string
  readonly byId?: Readonly<Record<string, { readonly running?: boolean } | undefined>>
}

/**
 * - `running`: the paired Challenger session is executing now.
 * - `interrupted`: the list is ready and the Challenger is not running, while
 *   the plan is still expecting execution work.
 * - `unknown`: the list has not arrived yet, so no claim is made.
 * - `inactive`: this plan is not in live peer execution (undelivered relay,
 *   review phase, terminal outcome, or a legacy plan without a peer).
 */
export type ChallengerActivity = 'running' | 'interrupted' | 'unknown' | 'inactive'

/**
 * Derive the live activity of the plan's executor from the card payload and the
 * official session list snapshot.
 *
 * A warning is only valid for a peer plan that is still in its execution phase:
 * nonterminal, `plan-ready` durably delivered, with an unreported execution
 * task, and not yet in Endeavour's review. Everything else reports `inactive`,
 * so a stopped Challenger can never be shown before delivery, during review or
 * after the plan finished.
 */
export function challengerActivity(data: EndeavourCardData, sessions: SessionActivityLike | undefined): ChallengerActivity {
  const applicable = data.terminal === undefined
    && data.pairId !== undefined
    && typeof data.challengerSessionId === 'string' && data.challengerSessionId !== ''
    && data.planReadyDelivered === true
    && typeof data.executionTaskId === 'string' && data.executionTaskId !== ''
  if (!applicable) return 'inactive'
  // The list is still arriving: say nothing rather than raise a false alarm.
  if (sessions === undefined || sessions.phase !== 'ready') return 'unknown'
  const row = sessions.byId?.[data.challengerSessionId as string]
  // A ready list without the row means the session is not running at all.
  return row?.running === true ? 'running' : 'interrupted'
}
