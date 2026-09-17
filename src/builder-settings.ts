/**
 * Builder route settings: the user-owned preference for the NEXT continuable
 * Builder child, installed as an official Host Settings section so the root
 * Endeavour composer can read and write it live without YAML edits or a
 * restart. Changing it never mutates an already-spawned Builder.
 */

import z from '@deepseek-ai/schemastery'
import { BUILDER_SETTINGS_NAMESPACE, type BuilderRouteSettings } from './builder-settings-shared.js'

/** Settings namespace owned by dsh-endeavour. */
export { BUILDER_SETTINGS_NAMESPACE }
export type { BuilderRouteSettings }

/** Schema of the Builder route settings section. */
export const BUILDER_SETTINGS_SCHEMA: z<BuilderRouteSettings> = z.object({
  mode: z.union(['inherit', 'custom'] as const).default('inherit'),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
})

/** The composition base supplied by the Cordis `builderAgentOptions` config. */
export interface BuilderRouteBase {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
}

/** Default stored preference when no settings section is available. */
export function defaultBuilderSettings(base: BuilderRouteBase = {}): BuilderRouteSettings {
  if (base.provider !== undefined && base.provider !== '' && base.model !== undefined && base.model !== '') {
    return {
      mode: 'custom',
      provider: base.provider,
      model: base.model,
      ...(base.reasoningEffort === undefined ? {} : { reasoningEffort: base.reasoningEffort }),
      ...(base.maxTokens === undefined ? {} : { maxTokens: base.maxTokens }),
    }
  }
  return { mode: 'inherit', ...base }
}

/**
 * Cross-field validation the schema cannot express: inherit takes no route,
 * custom requires a non-empty provider/model pair, and optional values must be
 * meaningful when present.
 * @returns one message per rejected field set, empty when valid.
 */
export function validateBuilderSettings(settings: BuilderRouteSettings): string[] {
  const failures: string[] = []
  if (settings.mode !== 'inherit' && settings.mode !== 'custom') {
    failures.push('mode must be "inherit" or "custom"')
    return failures
  }
  if (settings.mode === 'inherit') {
    if (settings.provider !== undefined && settings.provider !== '') failures.push('provider is not allowed in inherit mode')
    if (settings.model !== undefined && settings.model !== '') failures.push('model is not allowed in inherit mode')
    return failures
  }
  if (settings.provider === undefined || settings.provider.trim() === '') failures.push('custom mode requires a provider')
  if (settings.model === undefined || settings.model.trim() === '') failures.push('custom mode requires a model')
  if (settings.reasoningEffort !== undefined && settings.reasoningEffort.trim() === '') failures.push('reasoningEffort must be non-empty when present')
  if (settings.maxTokens !== undefined && (!Number.isSafeInteger(settings.maxTokens) || settings.maxTokens < 1)) failures.push('maxTokens must be a positive integer')
  return failures
}

/** One resolved exact child route. */
export interface ResolvedBuilderRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly maxTokens?: number
  /** True when the route follows the Planner rather than a custom pin. */
  readonly inherited: boolean
}

/** Copy settings defensively so later mutations cannot change a captured route. */
export function snapshotBuilderSettings(settings: BuilderRouteSettings): BuilderRouteSettings {
  return {
    mode: settings.mode,
    ...(settings.provider === undefined ? {} : { provider: settings.provider }),
    ...(settings.model === undefined ? {} : { model: settings.model }),
    ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
    ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
  }
}
