import { describe, expect, it } from 'vitest'
import { TASK_STATUS_PHRASES } from '../src/domain.js'
import { en, NS, ru } from '../src/client/locales.js'
import { formatElapsed } from '../src/client/PlanCard.js'
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

describe('locale surface', () => {
  it('carries the four exact Russian status phrases in both dictionaries', () => {
    expect(TASK_STATUS_PHRASES).toEqual({
      waiting: 'Ожидает начала',
      running: 'Выполняется',
      succeeded: 'Выполнился успешно',
      failed: 'Не выполнился',
    })
    expect(ru['status.waiting']).toBe('Ожидает начала')
    expect(ru['status.running']).toBe('Выполняется')
    expect(ru['status.succeeded']).toBe('Выполнился успешно')
    expect(ru['status.failed']).toBe('Не выполнился')
    expect(NS).toBe('endeavour')
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort())
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
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'План',
      tasks: [spec('t1', 'Коротко'), spec('t2', 'Ещё короче')], at: 0,
    })
    const card = projectPlanCard(plan)
    expect(JSON.stringify(card)).not.toContain('instructions')
    expect(card.tasks.map((task) => task.title)).toEqual(['Коротко', 'Ещё короче'])
    expect(card.total).toBe(2)
  })

  it('projects running, checking, and frozen duration states', () => {
    let plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'План',
      tasks: [spec('t1', 'Раз'), spec('t2', 'Два')], at: 0,
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
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'План',
      tasks: [spec('t1', 'Раз')], at: 0,
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
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'План',
      tasks: [spec('t1', 'Раз')], at: 0,
    })
    const newer = { ...plan, sequence: 5 }
    const context = { state: newer } as never
    const stale = { event: { type: 'endeavour/plan', data: { kind: 'task-started', plan } }, location: { kind: 'session' } }
    const result = endeavourPlanDefinition.update(context, stale as never)
    expect(result.sequence).toBe(5)
  })
})
