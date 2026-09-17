/**
 * dsh-endeavour global host bundle.
 *
 * Provides the durable orchestration service, registers the `endeavourPlan`
 * session projection the dock reads, and applies the rc.2 runtime admission
 * shim for the plugin's informational `endeavour/plan` events.
 */

import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { EndeavourService, type EndeavourConfig } from './service.js'
import { registerEndeavourProjection } from './projection-host.js'

export const name = 'endeavour'

/** Required services: subagents, sessions, and the projection registry. */
export const inject = ['subagents', 'sessions', 'sessionProjections']

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
export function admitEndeavourEvents(known: ReadonlySet<string> = KNOWN_SESSION_EVENT_TYPES): void {
  (known as Set<string>).add('endeavour/plan')
}

export function apply(ctx: Context, config: EndeavourConfig = {}): void {
  admitEndeavourEvents()
  new EndeavourService(ctx, config)
  registerEndeavourProjection(ctx)
}
