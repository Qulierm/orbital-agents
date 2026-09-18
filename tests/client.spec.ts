import { describe, expect, it } from 'vitest'
import { TASK_STATUSES } from '../src/domain.js'
import { en, formatEnglish, NS } from '../src/client/locales.js'
import { formatElapsed } from '../src/client/PlanView.js'
import { endeavourPlanDefinition } from '../src/client/definition.js'
import { projectPlanCard, taskStage } from '../src/plan-projection.js'
import {
  createPlanState, PlanId, startTask, TaskId, verifyTask, reportTask, type TaskSpec,
} from '../src/domain.js'

function spec(id: string, title: string): TaskSpec {
  return {
    id: TaskId(id),
    display: { title },
    execution: { instructions: `${title} instructions`, validation: `${title} validation` },
  }
}

describe('English-only copy surface', () => {
  it('declares exactly the four durable states and the five display stages in English', () => {
    expect(TASK_STATUSES).toEqual(['waiting', 'running', 'succeeded', 'failed'])
    expect(en['stage.waiting']).toBe('Waiting to start')
    expect(en['stage.working']).toBe('Working')
    expect(en['stage.finished']).toBe('Finished')
    expect(en['stage.confirmed']).toBe('Confirmed')
    expect(en['stage.failed']).toBe('Failed')
    expect(NS).toBe('endeavour')
    // No completion announcement remains in the copy surface.
    expect(Object.keys(en)).not.toContain('plan.completed')
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('interpolates concise confirmed progress and never falls back to another language', () => {
    expect(formatEnglish('plan.progress', { confirmed: 2, total: 3 })).toBe('2 / 3 confirmed')
    expect(formatEnglish('plan.openBuilder')).toBe('Open Challenger')
  })

  it('formats the elapsed timer as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(-5)).toBe('00:00')
  })
})

describe('display stages derive from durable state', () => {
  it('maps waiting, working, finished, confirmed, failed without changing legality', () => {
    const waiting = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'One')], at: 0,
    })
    expect(taskStage(waiting.tasks[0]!)).toBe('waiting')

    const working = startTask(waiting, TaskId('t1'), 1_000)
    expect(working.tasks[0]?.status).toBe('running')
    expect(taskStage(working.tasks[0]!)).toBe('working')

    // A Builder report yields Finished while the persisted status stays running.
    const reported = reportTask(working, TaskId('t1'), { summary: 's', files: [], validation: 'v' }, 2_000)
    expect(reported.tasks[0]?.status).toBe('running')
    expect(taskStage(reported.tasks[0]!)).toBe('finished')

    // Only Endeavour verification yields Confirmed.
    const confirmed = verifyTask(reported, TaskId('t1'), 'succeeded', undefined, 3_000)
    expect(confirmed.tasks[0]?.status).toBe('succeeded')
    expect(taskStage(confirmed.tasks[0]!)).toBe('confirmed')

    const failed = verifyTask(reported, TaskId('t1'), 'failed', 'No', 3_000)
    expect(taskStage(failed.tasks[0]!)).toBe('failed')
  })

  it('projects identity, stages, report time, and confirmed counts', () => {
    let plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'One')], at: 0,
    })
    plan = startTask(plan, TaskId('t1'), 1_000)
    plan = reportTask(plan, TaskId('t1'), { summary: 's', files: [], validation: 'v' }, 2_000)
    let card = projectPlanCard(plan)
    expect(card.rootSessionId).toBe('root')
    expect(card.tasks[0]?.stage).toBe('finished')
    expect(card.tasks[0]?.reportedAt).toBe(2_000)
    expect(card.completedCount).toBe(0)
    plan = verifyTask(plan, TaskId('t1'), 'succeeded', undefined, 3_000)
    card = projectPlanCard(plan)
    expect(card.completedCount).toBe(1)
    // Duration stays frozen at the report time through confirmation.
    expect(card.tasks[0]?.finishedAt).toBe(2_000)
    expect(JSON.stringify(card)).not.toContain('instructions')
  })
})

describe('conversation node definition', () => {
  it('matches only the durable endeavour/plan family', () => {
    const plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'One')], at: 0,
    })
    const startEvent = { type: 'endeavour/plan', data: { kind: 'plan-created', at: 0, plan }, seq: 1 }
    const updateEvent = { type: 'endeavour/plan', data: { kind: 'task-started', at: 1, plan: { ...plan, sequence: 1 } }, seq: 2 }
    expect(endeavourPlanDefinition.match(startEvent as never)).toEqual({ id: 'p1', role: 'start' })
    expect(endeavourPlanDefinition.match(updateEvent as never)).toEqual({ id: 'p1', role: 'update' })
    expect(endeavourPlanDefinition.match({ type: 'user/message', data: {} } as never)).toBeNull()
    expect(endeavourPlanDefinition.match({ type: 'assistant/message', data: {} } as never)).toBeNull()
  })

  it('ignores stale whole-value replays during update', () => {
    const plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'One')], at: 0,
    })
    const newer = { ...plan, sequence: 5 }
    const context = { state: newer } as never
    const stale = { event: { type: 'endeavour/plan', data: { kind: 'task-started', plan } }, location: { kind: 'session' } }
    const result = endeavourPlanDefinition.update(context, stale as never)
    expect(result.sequence).toBe(5)
  })
})
