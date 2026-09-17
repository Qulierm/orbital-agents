/**
 * Scoped orchestration tools plugin (`dsh-endeavour/tools`).
 *
 * This module is mounted as a row inside an agent preset, so the four
 * model-facing tools exist only for agents joined to that preset's scope. The
 * global bundle (`dsh-endeavour`) only provides the durable service the client
 * and session orchestration depend on; it never registers model tools, which
 * keeps the standard preset free of Endeavour tooling.
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerTools } from './tools.js'

export const name = 'endeavour-tools'

/**
 * `tools` is the registry the rows register into; `endeavour` is the provided
 * durable service. Requiring both means this plugin cannot mount where the
 * service is absent, and the service is only provided by the global bundle.
 */
export const inject = ['tools', 'endeavour']

/** Register the four role-guarded orchestration tools in this scope. */
export function apply(ctx: Context): void {
  registerTools(ctx, ctx.endeavour)
}
