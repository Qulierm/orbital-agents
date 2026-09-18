/**
 * Pure model for the Builder route control: visibility rules, chip labels,
 * effort options, and stale-effort resets. The React component and its tests
 * share these functions so the behavior stays in one place.
 */

import type { ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
import type { BuilderRouteSettings } from '../builder-settings.js'

/** Visibility inputs taken from the session projections and session state. */
export interface BuilderRouteVisibility {
  /** `agentPreset` projection value for the current session. */
  readonly agentPreset: string | undefined
  /** True when the current session is an addressed subagent (Builder child). */
  readonly isSubagent: boolean
  /** True when the Endeavour plan is active (no terminal outcome yet). */
  readonly planActive: boolean
  /** True while the parent session is running a turn. */
  readonly running: boolean
}

/** Whether the control renders at all. */
export function builderControlVisible(input: BuilderRouteVisibility): boolean {
  return input.agentPreset === 'endeavour' && !input.isSubagent
}

/** Whether the control is disabled, with the English reason for the title. */
export function builderControlDisabled(input: BuilderRouteVisibility): string | undefined {
  if (!builderControlVisible(input)) return 'Builder route is only available in Endeavour chats'
  if (input.planActive) return 'The Builder route is fixed while a plan is active'
  if (input.running) return 'Finish the current turn to change the Builder route'
  return undefined
}

/** Compact chip label: `Builder · Inherit` or `Builder · <model> · <effort>`. */
/** The session's projected model selection (ui-model-selection contract). */
export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Projection face: `next` is the effective/pending session selection. */
export interface ModelSelectionProjectionLike {
  readonly next?: ModelSelectionLike
}

/**
 * The route the Builder inherits right now: the session's projected selection
 * when available, otherwise the catalog default (before the first request).
 */
export function effectiveSelection(
  projection: unknown,
  catalog: { readonly default?: ModelSelectionLike } | undefined,
): ModelSelectionLike | undefined {
  const next = (projection as ModelSelectionProjectionLike | undefined)?.next
  return next ?? catalog?.default
}

/** Display name for a selection: the catalog name, else the raw model id. */
export function modelLabelFor(
  selection: ModelSelectionLike | undefined,
  model: ModelCatalogModel | undefined,
): string | undefined {
  if (selection === undefined) return undefined
  return model?.name ?? selection.model
}

/** The effective effort id: the explicit one, else the model's default. */
export function effectiveEffortId(
  model: ModelCatalogModel | undefined,
  effort: string | undefined,
): string | undefined {
  return effort ?? model?.reasoning?.defaultEffort
}

/** Effort display name; `undefined` when the model has no reasoning at all. */
export function effortLabelFor(model: ModelCatalogModel | undefined, effort: string | undefined): string | undefined {
  if (!modelHasThinking(model)) return undefined
  const effective = effectiveEffortId(model, effort)
  if (effective === undefined) return undefined
  return model?.reasoning?.efforts.find((level) => level.id === effective)?.name ?? effective
}

/** The selected model metadata from a catalog, when present. */
export function findCatalogModel(
  catalog: { readonly groups: readonly { readonly id: string; readonly models: readonly ModelCatalogModel[] }[] } | undefined,
  provider: string | undefined,
  model: string | undefined,
): ModelCatalogModel | undefined {
  if (catalog === undefined || provider === undefined || model === undefined) return undefined
  return catalog.groups.find((group) => group.id === provider)?.models.find((candidate) => candidate.id === model)
}

/** One selectable thinking option. */
export interface ThinkingOption {
  /** `undefined` means the provider default. */
  readonly effort: string | undefined
  readonly label: string
  readonly description?: string
  readonly selected: boolean
}

/**
 * Thinking options for a model: the adapter-owned effort list plus the provider
 * default. A model without reasoning metadata yields no options.
 */
export function thinkingOptions(model: ModelCatalogModel | undefined, current: string | undefined): readonly ThinkingOption[] {
  const reasoning = model?.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return []
  return [
    { effort: undefined, label: 'Provider default', selected: current === undefined },
    ...reasoning.efforts.map((effort) => ({
      effort: effort.id,
      label: effort.name,
      ...(effort.description === undefined ? {} : { description: effort.description }),
      selected: current === effort.id,
    })),
  ]
}

/**
 * Effort to persist when the model changes: the model's declared default when
 * present, otherwise the provider default. A stale effort from the previous
 * model is never carried across.
 */
export function resetEffortForModel(model: ModelCatalogModel | undefined): string | undefined {
  return model?.reasoning?.defaultEffort
}

/** Whether the chosen model supports selectable reasoning at all. */
export function modelHasThinking(model: ModelCatalogModel | undefined): boolean {
  return (model?.reasoning?.efforts.length ?? 0) > 0
}
