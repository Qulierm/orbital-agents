/**
 * Plan UI copy: English only, for every supported DSH locale and the fallback.
 * Plans are always authored and displayed in English, like Builder reports.
 */

export const NS = 'endeavour'

export const en = {
  'plan.title': 'Endeavour plan',
  'plan.progress': '{confirmed} / {total} confirmed',
  'plan.current': 'Current task: {title}',
  'plan.checking': 'Endeavour is checking the result',
  'plan.openBuilder': 'Open Challenger',
  'plan.openEndeavour': 'Open Endeavour',
  'plan.openLegacyBuilder': 'Open Builder',
  'plan.openLegacyHint': 'Legacy plan: open its history from Subagents',
  'peer.return': 'Endeavour',
  'peer.returnTitle': 'Open the paired Endeavour session',
  'view.challenger': 'Challenger',
  'view.builder': 'Builder',
  'view.endeavour': 'Endeavour',
  'plan.collapse': 'Collapse plan',
  'plan.expand': 'Expand plan',
  'stage.waiting': 'Waiting to start',
  'stage.working': 'Working',
  'stage.finished': 'Finished',
  'stage.confirmed': 'Confirmed',
  'stage.failed': 'Failed',
  'stage.interrupted': 'Challenger stopped',
  'builder.title': 'Builder model',
  'role.builder': 'Challenger',
  'role.endeavour': 'Endeavour',
  'role.endeavourTitle': 'Endeavour model (this session)',
  'unified.trigger': 'Model settings: Endeavour and Challenger',
  'challenger.trigger': 'Challenger model and effort',
  /** Accessible description carrying the full current selection or status. */
  'challenger.triggerWith': 'Challenger model and effort: {selection}',
  'challenger.pending': 'Saved in this browser; waiting for Challenger',
  'challenger.pendingError': 'Saved choice is waiting after an apply error',
  'challenger.waitingForPeer': 'Choices are saved locally until Challenger is ready',
  'challenger.storageError': 'Could not access the saved choice in this browser',
  'challenger.selectionError': 'The choice was not saved or applied. Retry or choose again.',
  'challenger.menu': 'Challenger model settings',
  'unified.endeavour': 'Endeavour',
  'unified.challenger': 'Challenger',
  'unified.error': 'Model settings unavailable',
  'unified.errorDetail': 'Details: {detail}',
  'unified.unavailable': '{role} is unavailable',
  'builder.model': 'Model',
  'builder.effort': 'Effort',
  'builder.default': 'Default',
  'builder.notAvailable': 'Not available',
  'builder.unset': 'Not set',
  'builder.loading': 'Loading models...',
  'builder.retry': 'Retry',
  'builder.error': 'Could not load models',
  'builder.saving': 'Saving...',
  'builder.saveFailed': 'Could not save the Builder route',
} as const

export type EndeavourKey = keyof typeof en

/** Render English copy with `{placeholder}` interpolation (fallback path). */
export function formatEnglish(key: EndeavourKey, params?: Record<string, string | number>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
