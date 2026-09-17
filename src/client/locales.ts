/** Plan-card locale copy: Russian primary, English fallback. */

export const NS = 'endeavour'

export const ru = {
  'plan.title': 'План Endeavour',
  'plan.progress': 'Выполнено {completed} из {total}',
  'plan.current': 'Текущая задача: {title}',
  'plan.checking': 'Endeavour проверяет результат',
  'plan.openBuilder': 'Открыть Builder',
  'plan.completed': 'План завершён',
  'plan.failed': 'План остановлен',
  'status.waiting': 'Ожидает начала',
  'status.running': 'Выполняется',
  'status.succeeded': 'Выполнился успешно',
  'status.failed': 'Не выполнился',
} as const

export const en = {
  'plan.title': 'Endeavour plan',
  'plan.progress': 'Completed {completed} of {total}',
  'plan.current': 'Current task: {title}',
  'plan.checking': 'Endeavour is checking the result',
  'plan.openBuilder': 'Open Builder',
  'plan.completed': 'Plan completed',
  'plan.failed': 'Plan stopped',
  'status.waiting': 'Waiting to start',
  'status.running': 'Running',
  'status.succeeded': 'Succeeded',
  'status.failed': 'Failed',
} as const

export type EndeavourKey = keyof typeof ru
