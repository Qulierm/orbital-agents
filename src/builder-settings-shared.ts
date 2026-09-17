/**
 * Shared between the host settings section and the browser control: the
 * namespace string and the stored preference shape. No host-only dependency
 * (schemastery) may leak into the client bundle through this module.
 */

/** Settings namespace shared by the host section and the browser control. */
export const BUILDER_SETTINGS_NAMESPACE = 'endeavour-builder'

/** Stored preference for the next Builder child. */
export interface BuilderRouteSettings {
  /** `inherit` follows the Planner route; `custom` pins provider/model. */
  mode: 'inherit' | 'custom'
  /** Provider route for custom mode. */
  provider?: string
  /** Provider-owned model id for custom mode. */
  model?: string
  /** Adapter-owned reasoning effort; absent means the provider default. */
  reasoningEffort?: string
  /** Optional output-token cap carried into the child Agent options. */
  maxTokens?: number
}
