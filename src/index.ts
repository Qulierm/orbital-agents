/**
 * dsh-endeavour global host bundle.
 *
 * Provides the durable orchestration service through the Cordis service
 * contract (`Service` → `ctx.provide('endeavour', …)`) so the client and
 * session orchestration can depend on it. Model-facing tools deliberately live
 * in the scoped `dsh-endeavour/tools` plugin instead: the standard preset must
 * not see Endeavour tooling, while an Endeavour-scoped parent and its
 * inherited Builder child both resolve this provided service.
 */

import type { Context } from '@deepseek-ai/cordis'
import { EndeavourService, type EndeavourConfig } from './service.js'

export const name = 'endeavour'

/** Required services: continuable subagents and the session log. */
export const inject = ['subagents', 'sessions']

/** Accepted row config; every field is optional. */
export type Config = EndeavourConfig

/** Mount the durable service. Tools are registered by `dsh-endeavour/tools`. */
export function apply(ctx: Context, config: EndeavourConfig = {}): void {
  new EndeavourService(ctx, config)
}
