/**
 * Two-phase protocol regressions: N reports -> ONE aggregate notification ->
 * N ordered verdicts, plus whole-plan/legacy briefs and projection derivation.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  allTasksReported,
  createPlanState,
  currentTask,
  executionCursor,
  firstBlockedReport,
  PlanId,
  reportTask,
  reviewCursor,
  startTask,
  TaskId,
  verifyTask,
  type TaskSpec,
} from '../src/domain.js'
import { projectPlanCard, taskStage } from '../src/plan-projection.js'
import { builderBrief, wholePlanBrief } from '../src/service.js'

function spec(id: string, title: string): TaskSpec {
  return {
    id: TaskId(id),
    display: { title },
    execution: { instructions: `do ${id}`, validation: `check ${id}` },
  }
}

function threeTasks() {
  return createPlanState({
    planId: PlanId('p1'),
    rootSessionId: 'root',
    childId: 'child',
    title: 'Plan',
    tasks: [spec('t1', 'First'), spec('t2', 'Second'), spec('t3', 'Third')],
    at: 0,
  })
}

describe('cursors and phases', () => {
  it('walks execution then review without confusing Finished rows', () => {
    let plan = threeTasks()
    expect(executionCursor(plan)?.spec.id).toBe('t1')
    expect(reviewCursor(plan)).toBeUndefined()
    expect(allTasksReported(plan)).toBe(false)

    plan = startTask(plan, TaskId('t1'), 1_000)
    expect(currentTask(plan)?.spec.id).toBe('t1')
    plan = reportTask(plan, TaskId('t1'), { summary: 'a', files: [], validation: 'ok' }, 2_000)
    // The Finished t1 row must not be "current" while t2 is unreported.
    expect(taskStage(plan.tasks[0]!)).toBe('finished')
    expect(currentTask(plan)?.spec.id).toBe('t2')
    expect(reviewCursor(plan)?.spec.id).toBe('t1')
    const card = projectPlanCard(plan)
    expect(card.currentTitle).toBe('Second')
    expect(card.checking).toBe(false)

    plan = startTask(plan, TaskId('t2'), 3_000)
    plan = reportTask(plan, TaskId('t2'), { summary: 'b', files: [], validation: 'ok' }, 4_000)
    plan = startTask(plan, TaskId('t3'), 5_000)
    plan = reportTask(plan, TaskId('t3'), { summary: 'c', files: [], validation: 'ok' }, 6_000)
    expect(allTasksReported(plan)).toBe(true)
    const reviewCard = projectPlanCard(plan)
    expect(reviewCard.checking).toBe(true)
    expect(reviewCard.currentTitle).toBe('First')
    expect(reviewCard.completedCount).toBe(0)
  })

  it('finalizes only after the last verdict and freezes durations at report time', () => {
    let plan = threeTasks()
    for (const [index, id] of ['t1', 't2', 't3'].entries()) {
      plan = startTask(plan, TaskId(id), 1_000 + index * 10)
      plan = reportTask(plan, TaskId(id), { summary: id, files: [], validation: 'ok' }, 2_000 + index * 10)
    }
    plan = verifyTask(plan, TaskId('t1'), 'succeeded', 'ok', 9_000)
    plan = verifyTask(plan, TaskId('t2'), 'succeeded', 'ok', 9_100)
    expect(plan.terminal).toBeUndefined()
    expect(projectPlanCard(plan).completedCount).toBe(2)
    plan = verifyTask(plan, TaskId('t3'), 'succeeded', 'ok', 9_200)
    expect(plan.terminal?.outcome).toBe('completed')
    expect(plan.tasks.map((task) => task.finishedAt)).toEqual([2_000, 2_010, 2_020])
  })

  it('keeps later Finished rows while an early blocker awaits review', () => {
    let plan = threeTasks()
    plan = startTask(plan, TaskId('t1'), 1_000)
    plan = reportTask(plan, TaskId('t1'), { summary: 'a', files: [], validation: 'no', blocker: 'no access' }, 2_000)
    expect(firstBlockedReport(plan)?.spec.id).toBe('t1')
    expect(() => startTask(plan, TaskId('t2'), 2_500)).toThrow()
    // Review is allowed immediately for the blocked head task.
    plan = verifyTask(plan, TaskId('t1'), 'failed', 'blocked', 3_000)
    expect(plan.terminal?.outcome).toBe('failed')
    expect(plan.tasks[1]?.status).toBe('waiting')
  })
})

describe('builder briefs', () => {
  it('delivers the whole plan with every ordered task and the protocol', () => {
    const brief = wholePlanBrief('Plan', 'brief', 'plan constraints', [spec('t1', 'First'), spec('t2', 'Second')])
    expect(brief).toContain('Plan: Plan')
    expect(brief).toContain('Objective:')
    expect(brief).toContain('Plan constraints: plan constraints')
    expect(brief).toContain('Task 1 [t1]: First')
    expect(brief).toContain('Task 2 [t2]: Second')
    expect(brief).toContain('Instructions:')
    expect(brief).toContain('do t1')
    expect(brief).toContain('Validation criteria:')
    expect(brief).toContain('check t2')
    expect(brief).toContain('Execute every task sequentially')
    expect(brief).toContain('continue DIRECTLY with the next task')
    expect(brief).toContain('one aggregate review request')
  })

  it('keeps the single-task formatter for a legacy active child', () => {
    const brief = builderBrief(undefined, undefined, spec('t2', 'Second'))
    expect(brief).toContain('Task: Second')
    expect(brief).toContain('do t2')
    expect(brief).toContain('check t2')
    expect(brief).toContain('builder_start_task with task_id "t2"')
    expect(brief).toContain('builder_report')
  })
})

describe('finished vs confirmed visuals', () => {
  const source = readFileSync('src/client/PlanView.tsx', 'utf8')
  const styles = readFileSync('src/client/styles.ts', 'utf8')

  it('uses a restrained check-ring for Finished and a distinct success check-ring for Confirmed', () => {
    const finished = source.slice(source.indexOf('function FinishedGlyph'), source.indexOf('function ConfirmedGlyph'))
    const confirmed = source.slice(source.indexOf('function ConfirmedGlyph'), source.indexOf('function FailedGlyph'))
    // Finished is a check-ring (check path) in the restrained neutral class.
    expect(finished).toContain('strokeLinejoin="round"')
    expect(finished).toContain('M4.6 7.1 6.2 8.7l3.2-3.4')
    expect(styles).toContain('.dsh-endeavour-glyph--finished { color: var(--dsw-alias-label-secondary); }')
    // Confirmed keeps its own success check-ring and class.
    expect(confirmed).toContain('M4.4 7.2 6.2 9l3.6-3.8')
    expect(styles).toContain('.dsh-endeavour-glyph--succeeded { color: var(--dsw-alias-state-success-primary); }')
  })
})
