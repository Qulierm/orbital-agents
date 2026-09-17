import { describe, expect, it } from 'vitest'
import { TASK_STATUSES } from '../src/domain.js'
import { en, formatEnglish, NS } from '../src/client/locales.js'
import { formatElapsed } from '../src/client/PlanView.js'
import { projectPlanCard, endeavourPlanDefinition } from '../src/client/definition.js'
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
  it('declares exactly the four states and renders every one in English', () => {
    expect(TASK_STATUSES).toEqual(['waiting', 'running', 'succeeded', 'failed'])
    expect(en['status.waiting']).toBe('Waiting to start')
    expect(en['status.running']).toBe('Running')
    expect(en['status.succeeded']).toBe('Succeeded')
    expect(en['status.failed']).toBe('Failed')
    expect(NS).toBe('endeavour')
  })

  it('interpolates English fallback copy and never falls back to another language', () => {
    expect(formatEnglish('plan.progress', { completed: 2, total: 3 })).toBe('Completed 2 of 3')
    expect(formatEnglish('plan.current', { title: 'Task' })).toBe('Current task: Task')
    expect(formatEnglish('plan.openBuilder')).toBe('Open Builder')
    // No copy value contains non-ASCII (i.e. no Cyrillic or other localized text).
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('formats the elapsed timer as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(3_600_000)).toBe('60:00')
    expect(formatElapsed(-5)).toBe('00:00')
  })
})

describe('plan card projection', () => {
  it('never exposes detailed instructions on the card', () => {
    const plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'Short one'), spec('t2', 'Short two')], at: 0,
    })
    const card = projectPlanCard(plan)
    expect(JSON.stringify(card)).not.toContain('instructions')
    expect(card.tasks.map((task) => task.title)).toEqual(['Short one', 'Short two'])
    expect(card.total).toBe(2)
  })

  it('projects running, checking, and frozen duration states', () => {
    let plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1', 'One'), spec('t2', 'Two')], at: 0,
    })
    plan = startTask(plan, TaskId('t1'), 1_000)
    expect(projectPlanCard(plan).checking).toBe(false)
    plan = reportTask(plan, TaskId('t1'), { summary: 's', files: [], validation: 'v' }, 2_000)
    expect(projectPlanCard(plan).checking).toBe(true)
    plan = verifyTask(plan, TaskId('t1'), 'succeeded', undefined, 3_000)
    const card = projectPlanCard(plan)
    expect(card.completedCount).toBe(1)
    expect(card.tasks[0]?.finishedAt).toBe(3_000)
    expect(card.terminal).toBeUndefined()
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
    // Builder Chat never carries these events, so the card can never render there.
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
