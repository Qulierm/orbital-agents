import { describe, expect, it } from 'vitest'
import {
  assertChildRole,
  assertRootRole,
  createPlanState,
  EndeavourError,
  foldPlanEvents,
  nextDispatch,
  PlanId,
  planEventPayload,
  reportTask,
  startTask,
  taskDurationMs,
  TaskId,
  verifyTask,
  type TaskSpec,
} from '../src/domain.js'

function tasks(): TaskSpec[] {
  return [
    {
      id: TaskId('t1'),
      display: { title: 'Первый шаг' },
      execution: { instructions: 'do the first thing', validation: 'first thing verified' },
    },
    {
      id: TaskId('t2'),
      display: { title: 'Второй шаг' },
      execution: { instructions: 'do the second thing', validation: 'second thing verified' },
    },
  ]
}

function plan() {
  return createPlanState({
    planId: PlanId('p1'),
    rootSessionId: 'root',
    childId: 'child',
    title: 'План',
    tasks: tasks(),
    at: 1_000,
  })
}

describe('plan state machine', () => {
  it('starts waiting with the exact four-state vocabulary', () => {
    const state = plan()
    expect(state.tasks.map((task) => task.status)).toEqual(['waiting', 'waiting'])
    expect(state.sequence).toBe(0)
  })

  it('starts only the current eligible task at explicit start time', () => {
    const state = startTask(plan(), TaskId('t1'), 2_000)
    expect(state.tasks[0]?.status).toBe('running')
    expect(state.tasks[0]?.startedAt).toBe(2_000)
  })

  it('rejects out-of-order starts', () => {
    expect(() => startTask(plan(), TaskId('t2'), 2_000)).toThrow(EndeavourError)
  })

  it('rejects duplicate starts and duplicate reports', () => {
    const running = startTask(plan(), TaskId('t1'), 2_000)
    expect(() => startTask(running, TaskId('t1'), 3_000)).toThrow(EndeavourError)
    const reported = reportTask(running, TaskId('t1'), {
      summary: 'done', files: ['a.ts'], validation: 'tests pass',
    }, 4_000)
    expect(() => reportTask(reported, TaskId('t1'), {
      summary: 'again', files: [], validation: 'tests pass',
    }, 5_000)).toThrow(EndeavourError)
  })

  it('keeps the public row running while checking', () => {
    const running = startTask(plan(), TaskId('t1'), 2_000)
    const reported = reportTask(running, TaskId('t1'), {
      summary: 'done', files: [], validation: 'ok',
    }, 3_000)
    expect(reported.tasks[0]?.status).toBe('running')
    expect(reported.tasks[0]?.report?.reportedAt).toBe(3_000)
  })

  it('rejects verification without a report', () => {
    const running = startTask(plan(), TaskId('t1'), 2_000)
    expect(() => verifyTask(running, TaskId('t1'), 'succeeded', undefined, 3_000)).toThrow(EndeavourError)
  })

  it('freezes duration at the report and completes only after every verdict', () => {
    let state = startTask(plan(), TaskId('t1'), 2_000)
    state = reportTask(state, TaskId('t1'), { summary: 'a', files: [], validation: 'ok' }, 3_000)
    // Report settles Finished evidence: the row is reported and its duration is
    // frozen at reportedAt even before Endeavour confirms.
    expect(state.tasks[0]?.report?.reportedAt).toBe(3_000)
    expect(taskDurationMs(state.tasks[0]!, 99_000)).toBe(1_000)
    // The next task starts without any Endeavour verdict.
    state = startTask(state, TaskId('t2'), 5_000)
    state = reportTask(state, TaskId('t2'), { summary: 'b', files: [], validation: 'ok' }, 6_000)
    expect(state.terminal).toBeUndefined()
    // Ordered review: t2 cannot be verified before t1.
    expect(() => verifyTask(state, TaskId('t2'), 'succeeded', undefined, 7_000)).toThrow(EndeavourError)
    state = verifyTask(state, TaskId('t1'), 'succeeded', 'checked', 7_500)
    expect(state.tasks[0]?.finishedAt).toBe(3_000)
    expect(state.terminal).toBeUndefined()
    state = verifyTask(state, TaskId('t2'), 'succeeded', 'checked', 8_000)
    expect(state.tasks[1]?.finishedAt).toBe(6_000)
    expect(state.terminal).toEqual({ outcome: 'completed', at: 8_000 })
  })

  it('stops the plan on an early failure report and keeps pending tasks waiting', () => {
    let state = startTask(plan(), TaskId('t1'), 2_000)
    // A failure/blocker report stops Builder progression immediately.
    state = reportTask(state, TaskId('t1'), { summary: 'a', files: [], validation: 'no', failure: 'test failed' }, 3_000)
    expect(() => startTask(state, TaskId('t2'), 3_500)).toThrow(EndeavourError)
    state = verifyTask(state, TaskId('t1'), 'failed', 'Проверка не прошла', 4_000)
    expect(state.terminal?.outcome).toBe('failed')
    expect(state.tasks[0]?.finishedAt).toBe(3_000)
    expect(state.tasks[1]?.status).toBe('waiting')
    expect(nextDispatch(state, TaskId('t1'))).toBeUndefined()
  })

  it('folds whole-value checkpoints and ignores stale replays', () => {
    let state = plan()
    const events = [planEventPayload('plan-created', undefined, state, 1_000)]
    state = startTask(state, TaskId('t1'), 2_000)
    events.push(planEventPayload('task-started', events.at(-1)!.plan, state, 2_000))
    const folded = foldPlanEvents([...events])
    expect(folded?.sequence).toBe(2)
    const stale = foldPlanEvents([...events, events[0]!])
    expect(stale?.sequence).toBe(2)
  })

  it('guards roles and exact child-parent lineage', () => {
    const state = plan()
    expect(() => assertRootRole(state, 'other')).toThrow(EndeavourError)
    expect(() => assertRootRole(state, 'root')).not.toThrow()
    expect(() => assertChildRole(state, 'child', 'root')).not.toThrow()
    expect(() => assertChildRole(state, 'child', 'other')).toThrow(EndeavourError)
    expect(() => assertChildRole(state, 'other', 'root')).toThrow(EndeavourError)
  })
})
