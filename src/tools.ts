/** Model-facing orchestration tools for the Endeavour root and its Builder child. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TaskId, type TaskSpec } from './domain.js'
import { builderBrief, EndeavourService, type BuilderReportInput } from './service.js'

interface ToolCallContext {
  readonly agent?: Agent
  readonly signal: AbortSignal
}

function callingAgent(exec: ToolCallContext): Agent {
  if (exec.agent === undefined) throw new Error('dsh-endeavour: tool requires a calling agent')
  return exec.agent
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

/** Parse the strict JSON task list accepted from the plan tool. */
export function parseTasks(raw: string): TaskSpec[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('dsh-endeavour: tasks_json must be a non-empty array')
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`dsh-endeavour: task ${index} must be an object`)
    }
    const record = entry as Record<string, unknown>
    for (const field of ['title', 'instructions', 'validation'] as const) {
      if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') {
        throw new Error(`dsh-endeavour: task ${index} is missing ${field}`)
      }
    }
    const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id : `task-${index + 1}`
    return {
      id: TaskId(id),
      display: { title: record.title as string },
      execution: {
        instructions: record.instructions as string,
        validation: record.validation as string,
        ...(typeof record.constraints === 'string' && record.constraints !== ''
          ? { constraints: record.constraints }
          : {}),
      },
    }
  })
}

function parseReport(raw: string): BuilderReportInput {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('dsh-endeavour: report_json must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.summary !== 'string' || record.summary === '') {
    throw new Error('dsh-endeavour: report_json requires summary')
  }
  if (typeof record.validation !== 'string' || record.validation === '') {
    throw new Error('dsh-endeavour: report_json requires validation')
  }
  const files = Array.isArray(record.files) ? record.files.filter((file): file is string => typeof file === 'string') : []
  return {
    summary: record.summary,
    files,
    validation: record.validation,
    ...(typeof record.blocker === 'string' && record.blocker !== '' ? { blocker: record.blocker } : {}),
    ...(typeof record.failure === 'string' && record.failure !== '' ? { failure: record.failure } : {}),
  }
}

/** Which role's catalog a mounted tools row exposes. */
export type ToolRole = 'endeavour' | 'challenger'

/**
 * Compatibility surface the role catalogs call. `EndeavourService` satisfies it
 * directly today; the C2 cutover may re-point it at peer methods without
 * changing the model-facing catalogs.
 */
export interface RoleToolService {
  createPlan(agent: Agent, input: {
    readonly title: string
    readonly brief: string
    readonly constraints?: string
    readonly tasks: readonly TaskSpec[]
  }): Promise<{ readonly planId: string; readonly taskCount: number }>
  verifyTask(agent: Agent, taskId: string, outcome: 'succeeded' | 'failed', note?: string): Promise<import('./domain.js').PlanState>
  challengerStartTask(agent: Agent, taskId: string): Promise<import('./domain.js').PlanState>
  challengerReport(agent: Agent, taskId: string, report: BuilderReportInput): Promise<import('./service.js').BuilderReportOutcome>
}

/**
 * Register exactly the role's model-facing catalog:
 * - `endeavour`: `endeavour_plan`, `endeavour_verify`
 * - `challenger`: `challenger_start_task`, `challenger_report`
 * A preset that does not mount this row (Standard) sees none of them.
 */
export function registerTools(ctx: Context, service: EndeavourService | RoleToolService, role: ToolRole = 'endeavour'): void {
  const compat = service as RoleToolService & EndeavourService
  const isEndeavour = role === 'endeavour'
  if (isEndeavour) {
  ctx.tools.register(defineTool({
    name: 'endeavour_plan',
    description: 'Endeavour-only. Create the single durable plan and start the Builder child with the WHOLE plan (every ordered task plus the sequential protocol). Tasks are provided as a JSON array of { title, instructions, validation, constraints?, id? }.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short user-visible plan title.' },
      brief: { type: 'string', required: true, description: 'Detailed Builder brief shared by all tasks.' },
      tasks_json: { type: 'string', required: true, description: 'JSON array of tasks: [{ title, instructions, validation, constraints? }].' },
      constraints: { type: 'string', description: 'Optional plan-wide constraints.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const parsed = JSON.parse(args.tasks_json) as unknown
      void parsed
      const tasks = parseTasks(args.tasks_json)
      const result = await compat.createPlan(callingAgent(exec as ToolCallContext), {
        title: args.title,
        brief: args.brief,
        tasks,
        ...(args.constraints === undefined || args.constraints === '' ? {} : { constraints: args.constraints }),
      })
      return `plan ${result.planId} created with ${String(result.taskCount)} tasks; the persistent Challenger received the whole-plan briefing`
    },
  }))

  }
  if (!isEndeavour) {
  ctx.tools.register(defineTool({
    name: 'challenger_start_task',
    description: 'Builder-only. Record the explicit durable start of the current execution item (the first task without a report) before executing it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Id of the current task from the brief.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const plan = await compat.challengerStartTask(callingAgent(exec as ToolCallContext), args.task_id)
      const task = plan.tasks.find((candidate) => candidate.spec.id === args.task_id)
      return `task ${args.task_id} started (${task?.status ?? 'running'})`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'challenger_report',
    description: 'Builder-only. Submit the structured report for the current task: it marks the task Finished and either returns the full brief of the next task (continue immediately), or states that all tasks are submitted (stop and wait for the aggregate review). A blocker/failure stops progression.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Id of the task being reported.' },
      report_json: { type: 'string', required: true, description: 'JSON object: { summary, files: string[], validation, blocker?, failure? }.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const outcome = await compat.challengerReport(
        callingAgent(exec as ToolCallContext),
        args.task_id,
        parseReport(args.report_json),
      )
      if (outcome.phase === 'blocked') {
        return `report submitted for ${args.task_id} (Finished) with a blocker/failure; progression stopped — later tasks stay waiting until Endeavour reviews this task.`
      }
      if (outcome.phase === 'review' || outcome.nextTask === undefined) {
        return `report submitted for ${args.task_id} (Finished); all ${String(outcome.plan.tasks.length)} tasks are submitted — stop and wait for Endeavour's aggregate review.`
      }
      return [
        `report submitted for ${args.task_id} (Finished). Continue with the next task now:`,
        builderBrief(undefined, undefined, outcome.nextTask),
      ].join('\n')
    },
  }))

  }
  if (isEndeavour) {
  ctx.tools.register(defineTool({
    name: 'endeavour_verify',
    description: 'Endeavour-only. Record the verdict for ONE reported task, in plan order. Review starts only after every task has a report (or immediately after an early blocker/failure). It never dispatches work; success confirms the item, failure terminates the plan.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Id of the reported task.' },
      outcome: { type: 'string', required: true, description: 'Either "succeeded" or "failed".' },
      note: { type: 'string', description: 'Short user-visible verification or failure note.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      if (args.outcome !== 'succeeded' && args.outcome !== 'failed') {
        throw new Error('dsh-endeavour: outcome must be "succeeded" or "failed"')
      }
      const plan = await compat.verifyTask(
        callingAgent(exec as ToolCallContext),
        args.task_id,
        args.outcome,
        args.note === undefined || args.note === '' ? undefined : args.note,
      )
      if (plan.terminal !== undefined) return `plan ${plan.terminal.outcome}`
      const remaining = plan.tasks.filter((task) =>
        task.report !== undefined && task.status !== 'succeeded' && task.status !== 'failed').length
      return `task ${args.task_id} ${args.outcome === 'succeeded' ? 'confirmed' : 'failed'}; ${String(remaining)} task report(s) still awaiting review`
    },
  }))
  }
}
