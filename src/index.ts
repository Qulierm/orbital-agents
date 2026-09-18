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
import type {} from '@deepseek-ai/dsh-settings'
import { EndeavourService, type EndeavourConfig } from './service.js'
import { registerEndeavourPeerProjection, registerEndeavourProjection } from './projection-host.js'
import {
  BUILDER_SETTINGS_NAMESPACE,
  BUILDER_SETTINGS_SCHEMA,
  defaultBuilderSettings,
  snapshotBuilderSettings,
  type BuilderRouteSettings,
} from './builder-settings.js'

export const name = 'endeavour'

/** Required services: subagents, sessions, and the projection registry. */
export const inject = ['subagents', 'sessions', 'sessionProjections', 'sessionController']

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
  // Additive peer lifecycle: observe only the CURRENT session so startup never
  // mass-creates companions for cold history. The plan service is unchanged and
  // does not depend on this yet.
  try {
    service.observeCurrentSession()
  } catch {
    // Peer provisioning is additive; a missing host seam must not break plans.
  }
  // The Builder route preference is an official Host Settings section owned by
  // this plugin; deployments without a settings provider keep the composition
  // base (or inherit) unchanged, so service tests need no settings mount.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(
      ctx,
      BUILDER_SETTINGS_NAMESPACE,
      BUILDER_SETTINGS_SCHEMA,
      defaultBuilderSettings(config.builderAgentOptions ?? {}),
      {
        setSource: (current: () => BuilderRouteSettings) => { service.setBuilderSettingsSource(() => snapshotBuilderSettings(current())) },
        onChange: () => {},
      },
    )
  })
  registerEndeavourProjection(ctx)
  registerEndeavourPeerProjection(ctx)
}
