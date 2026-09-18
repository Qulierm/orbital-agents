/**
 * dsh-endeavour global host bundle.
 *
 * Provides the durable orchestration service, registers the `endeavourPlan`
 * session projection the dock reads, and applies the rc.2 runtime admission
 * shim for the plugin's informational `endeavour/plan` events.
 */

import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
// Type-only: resolves the ctx.settings service declaration.
import { EndeavourService, type EndeavourConfig } from './service.js'
import { registerEndeavourPeerProjection, registerEndeavourProjection } from './projection-host.js'

export const name = 'endeavour'

/** Required services: subagents, sessions, and the projection registry. */
export const inject = ['sessions', 'sessionProjections', 'sessionController']

/** Accepted row config; every field is optional. */
export type Config = EndeavourConfig

/**
 * Mount the durable service and the plan projection.
 *
 * rc.2 compatibility shim: `session.append` has no `ignorable` option, so
 * `endeavour/plan` events are written without the envelope marker that the
 * stored-log validator requires for unknown informational types. Admitting the
 * type here (before any session is opened) keeps restart replay working while
 * the plugin is mounted. The durable marker itself is applied offline by the
 * installer's session repair, and this admission is deliberately kept for the
 * whole process lifetime — never removed at runtime.
 */
export function admitEndeavourEvents(
  known: ReadonlySet<string> = KNOWN_SESSION_EVENT_TYPES,
): void {
  // Structural cast: the admission set is the runtime Set behind the readonly view.
  const admit = known as unknown as { add(value: string): unknown }
  admit.add('endeavour/plan')
  admit.add('endeavour/peer')
}

export function apply(ctx: Context, config: EndeavourConfig = {}): void {
  admitEndeavourEvents()
  const service = new EndeavourService(ctx, config)
  // Peer lifecycle: observe the ATTACHED sessions once, then every
  // `session/created` announcement, so an eligible Endeavour session gets its
  // Challenger without waiting for a plan. Cold persisted history is never
  // touched, and the effect disposes the subscription on HMR/unmount.
  try {
    ctx.effect(() => service.observeSessionLifecycle())
  } catch {
    // Peer provisioning is additive; a missing host seam must not break plans.
  }
  registerEndeavourProjection(ctx)
  registerEndeavourPeerProjection(ctx)
}
