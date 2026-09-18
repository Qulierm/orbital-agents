/**
 * Role-aware plan action model.
 *
 * One shared canonical plan renders on BOTH ordinary peers, so the action
 * depends on WHO is looking: the Endeavour side opens its persistent
 * Challenger, the Challenger side opens the paired Endeavour root, and a
 * historical `childId`-only card stays a disabled history affordance. A
 * Challenger NEVER targets itself.
 */

import type { EndeavourCardData } from '../plan-projection.js'

/** Peer role a plan action navigates to. */
export type PlanActionRole = 'challenger' | 'endeavour'

/** Resolved action for the plan surface currently rendering. */
export type PlanAction =
  /** Historical plan without a persistent peer: disabled, history only. */
  | { readonly kind: 'legacy' }
  /** Canonical peer plan: open the exact counterpart. */
  | { readonly kind: 'peer'; readonly target: string; readonly role: PlanActionRole }

/**
 * Resolve the action for one card on one session.
 * @param data - projected card data.
 * @param currentSessionId - the session currently rendering the surface.
 * @returns the action; malformed peer data degrades to the legacy affordance
 *   instead of ever opening the current session itself.
 */
export function planAction(data: EndeavourCardData, currentSessionId: string | undefined): PlanAction {
  const challenger = typeof data.challengerSessionId === 'string' ? data.challengerSessionId : ''
  if (challenger === '') return { kind: 'legacy' }
  if (currentSessionId !== undefined && currentSessionId === challenger) {
    const root = typeof data.rootSessionId === 'string' ? data.rootSessionId : ''
    // On the Challenger the counterpart is the root; never itself.
    return root === '' || root === challenger
      ? { kind: 'legacy' }
      : { kind: 'peer', target: root, role: 'endeavour' }
  }
  return { kind: 'peer', target: challenger, role: 'challenger' }
}

/** Locale key for the action label (legacy keeps its history wording). */
export function planActionLabelKey(action: PlanAction): 'plan.openBuilder' | 'plan.openEndeavour' | 'plan.openLegacyBuilder' {
  if (action.kind === 'legacy') return 'plan.openLegacyBuilder'
  return action.role === 'endeavour' ? 'plan.openEndeavour' : 'plan.openBuilder'
}
