/**
 * dsh-endeavour host plugin: registers the durable orchestration service and
 * the four scoped model-facing tools.
 *
 * Bundled as one Loader row by `cordis.patch.yml`; the browser half lives in
 * `./client` and is loaded by the DSH client module system.
 */

import type { Context } from '@deepseek-ai/cordis'
import { EndeavourService, type EndeavourConfig } from './service.js'
import { registerTools } from './tools.js'

export const name = 'endeavour'

/** Required services: tool registry, continuable subagents, session log. */
export const inject = ['tools', 'subagents', 'sessions']

/** Accepted row config; every field is optional. */
export type Config = EndeavourConfig

/** Mount the service and its tools. */
export function apply(ctx: Context, config: EndeavourConfig = {}): void {
  const service = new EndeavourService(ctx, config)
  registerTools(ctx, service)
}
