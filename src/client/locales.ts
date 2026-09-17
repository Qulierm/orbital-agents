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
  'plan.openBuilder': 'Open Builder',
  'plan.collapse': 'Collapse plan',
  'plan.expand': 'Expand plan',
  'stage.waiting': 'Waiting to start',
  'stage.working': 'Working',
  'stage.finished': 'Finished',
  'stage.confirmed': 'Confirmed',
  'stage.failed': 'Failed',
  'builder.title': 'Builder model',
  'builder.inherit': 'Inherit Planner',
  'builder.chipInherit': 'Inherit',
  'builder.inheritHint': 'Use the Planner route for the Builder child',
  'builder.models': 'Model',
  'builder.thinking': 'Thinking',
  'builder.providerDefault': 'Provider default',
  'builder.notAvailable': 'Not available',
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
