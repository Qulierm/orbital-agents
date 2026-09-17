/**
 * Plan UI copy: English only, for every supported DSH locale and the fallback.
 * Plans are always authored and displayed in English, like Builder reports.
 */

export const NS = 'endeavour'

export const en = {
  'plan.title': 'Endeavour plan',
  'plan.progress': 'Completed {completed} of {total}',
  'plan.current': 'Current task: {title}',
  'plan.checking': 'Endeavour is checking the result',
  'plan.openBuilder': 'Open Builder',
  'plan.completed': 'Plan completed',
  'plan.failed': 'Plan stopped',
  'plan.collapse': 'Collapse plan',
  'plan.expand': 'Expand plan',
  'status.waiting': 'Waiting to start',
  'status.running': 'Running',
  'status.succeeded': 'Succeeded',
  'status.failed': 'Failed',
} as const

export type EndeavourKey = keyof typeof en

/** Render English copy with `{placeholder}` interpolation (fallback path). */
export function formatEnglish(key: EndeavourKey, params?: Record<string, string | number>): string {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}
