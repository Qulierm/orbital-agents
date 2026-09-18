/**
 * Model-facing peer protocol text: the whole-plan briefing delivered at plan
 * creation and the single ordered aggregate review request. Kept free of
 * service imports so both the service and the cutover helpers can use them
 * without a cycle.
 */

import type { PlanState, TaskSpec } from './domain.js'

/**
 * Compose the whole-plan Builder prompt: objective, plan constraints, every
 * task in order with its instructions/validation/task constraints, and the
 * exact sequential protocol. Never rendered on the card.
 */
export function wholePlanBrief(
  title: string,
  brief: string,
  constraints: string | undefined,
  tasks: readonly TaskSpec[],
): string {
  const lines: string[] = [
    `Plan: ${title}`,
    'Objective:',
    brief,
  ]
  if (constraints !== undefined && constraints !== '') lines.push(`Plan constraints: ${constraints}`)
  lines.push('', `Ordered tasks (${String(tasks.length)}):`)
  tasks.forEach((task, index) => {
    lines.push(
      `Task ${String(index + 1)} [${task.id}]: ${task.display.title}`,
      'Instructions:',
      task.execution.instructions,
      'Validation criteria:',
      task.execution.validation,
    )
    if (task.execution.constraints !== undefined && task.execution.constraints !== '') {
      lines.push(`Task constraints: ${task.execution.constraints}`)
    }
    lines.push('')
  })
  lines.push(
    'Protocol:',
    'Execute every task sequentially in this order on your own.',
    'Before each task call builder_start_task with its task_id; after finishing it call builder_report with your summary, files, and validation evidence.',
    'After a report continue DIRECTLY with the next task; do not wait for a reply and never send an ordinary message to the parent.',
    'Stop only after the final task has been reported, or immediately when a task has a blocker or failure (later tasks stay waiting).',
    'The parent receives one aggregate review request when all tasks are reported (or immediately on a blocker/failure) and will verify each task in order.',
  )
  return lines.join('\n')
}

/**
 * Tools a Builder must never call: ordinary parent messaging, agent
 * list/interrupt, delegation, background job control, and workflow tools.
 * Coding, filesystem, search, validation, and the scoped builder protocol
 * tools stay available (scoped registrations ignore restrictions).
 */
export const BUILDER_DEFAULT_DENY: readonly string[] = [
  'send_message',
  'list_agents',
  'interrupt_agent',
  'subagent',
  'subagent_fork',
  'job_output',
  'job_list',
  'job_kill',
  'workflow',
  'ralph',
]

/** One aggregate review request covering every reported task in order. */
export function aggregateReviewRequest(plan: PlanState, blocked: boolean): string {
  const lines = [
    blocked
      ? 'Builder reported a blocker/failure and stopped. Review the affected task and record its verdict with endeavour_verify.'
      : `Builder submitted reports for all ${String(plan.tasks.length)} tasks. Review every task in order and call endeavour_verify for each one.`,
    '',
    'Ordered report evidence:',
  ]
  plan.tasks.forEach((task, index) => {
    const report = task.report
    if (report === undefined) {
      lines.push(`${String(index + 1)}. [${task.spec.id}] ${task.spec.display.title} — no report (waiting)`)
      return
    }
    lines.push(
      `${String(index + 1)}. [${task.spec.id}] ${task.spec.display.title}`,
      `   Summary: ${report.summary}`,
      `   Files: ${report.files.join(', ') || 'none'}`,
      `   Validation: ${report.validation}`,
    )
    if (report.blocker !== undefined) lines.push(`   Blocker: ${report.blocker}`)
    if (report.failure !== undefined) lines.push(`   Failure: ${report.failure}`)
  })
  lines.push(
    '',
    'Inspect each report, the workspace, and the evidence, then record one verdict per task in plan order with endeavour_verify. Do not dispatch anything to the Builder.',
  )
  return lines.join('\n')
}
