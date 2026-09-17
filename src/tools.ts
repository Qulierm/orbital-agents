/** Model-facing orchestration tools for the Endeavour root and its Builder child. */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TaskId, type TaskSpec } from './domain.js'
import { EndeavourService, type BuilderReportInput } from './service.js'

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

/** Register the four scoped orchestration tools. */
export function registerTools(ctx: Context, service: EndeavourService): void {
  ctx.tools.register(defineTool({
    name: 'endeavour_plan',
    description: 'Endeavour-only. Create the single durable plan and start the Builder child with the first detailed task. Tasks are provided as a JSON array of { title, instructions, validation, constraints?, id? }.',
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
      const result = await service.createPlan(callingAgent(exec as ToolCallContext), {
        title: args.title,
        brief: args.brief,
        tasks,
        ...(args.constraints === undefined || args.constraints === '' ? {} : { constraints: args.constraints }),
      })
      return `plan ${result.planId} created with ${String(result.taskCount)} tasks; Builder child ${result.childId} started`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'builder_start_task',
    description: 'Builder-only. Record the explicit durable start of the current task before executing it.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Id of the current task from the brief.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const plan = await service.builderStartTask(callingAgent(exec as ToolCallContext), args.task_id)
      const task = plan.tasks.find((candidate) => candidate.spec.id === args.task_id)
      return `task ${args.task_id} started (${task?.status ?? 'running'})`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'builder_report',
    description: 'Builder-only. Submit the structured report (summary, files, validation, optional blocker/failure) for the current task, then stop and wait for Endeavour verification.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Id of the task being reported.' },
      report_json: { type: 'string', required: true, description: 'JSON object: { summary, files: string[], validation, blocker?, failure? }.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const plan = await service.builderReport(
        callingAgent(exec as ToolCallContext),
        args.task_id,
        parseReport(args.report_json),
      )
      const task = plan.tasks.find((candidate) => candidate.spec.id === args.task_id)
      return `report submitted for ${args.task_id}; awaiting Endeavour verification`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'endeavour_verify',
    description: 'Endeavour-only. Record the quick-check verdict for a reported task. Success freezes the duration and dispatches the next task; failure stops the plan for this MVP.',
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
      const plan = await service.verifyTask(
        callingAgent(exec as ToolCallContext),
        args.task_id,
        args.outcome,
        args.note === undefined || args.note === '' ? undefined : args.note,
      )
      return plan.terminal === undefined
        ? `task ${args.task_id} ${args.outcome}; next task dispatched`
        : `plan ${plan.terminal.outcome}`
    },
  }))
}
