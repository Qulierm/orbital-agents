// @vitest-environment happy-dom
/**
 * Live Challenger interruption on the active plan.
 *
 * RED suite for the requested behaviour: while a delivered peer plan is still
 * executing, a Challenger session that is no longer running (turn stopped,
 * aborted, errored, or the row gone) must be visible on the plan without
 * opening that chat. Today the card/dock derive only durable stages, so the
 * row keeps saying Working until the user notices by hand.
 *
 * The official activity source is the Session Controller list snapshot
 * (`SessionListState.byId[sessionId].running`, phase `'pending' | 'ready'`),
 * which every session-scoped slot receives as the standard `useSessions` hook.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  createPlanState, markDeliveryDelivered, markDeliveryPending, PlanId, planEventPayload, TaskId,
  type PlanState, type TaskSpec,
} from '../src/domain.js'
import { challengerActivity, type SessionActivityLike } from '../src/client/challenger-activity.js'
import { projectPlanCard, type EndeavourCardData } from '../src/plan-projection.js'
import { PlanCard } from '../src/client/PlanCard.js'
import { PlanDock } from '../src/client/PlanDock.js'
import { STYLE_TEXT } from '../src/client/styles.js'

const ROOT = 'session-root'
const CHALLENGER = 'session-challenger'
const PAIR = 'pair-x'

function spec(id: string): TaskSpec {
  return { id: TaskId(id), display: { title: id }, execution: { instructions: `do ${id}`, validation: `check ${id}` } }
}

/** A peer plan whose `plan-ready` relay is durably delivered. */
function deliveredPeerPlan(): PlanState {
  const plan = createPlanState({
    planId: PlanId('p1'), rootSessionId: ROOT, challengerSessionId: CHALLENGER, pairId: PAIR,
    title: 'Live plan', tasks: [spec('t1'), spec('t2')], at: 1_000, executionBrief: 'brief',
  })
  const key = `${PAIR}:p1:plan-ready`
  const pending = markDeliveryPending(plan, { kind: 'plan-ready', key, at: 1_000, targetSessionId: CHALLENGER }, 1_000)
  return markDeliveryDelivered(pending, key, 'receipt', 1_001)
}

/** Extra renderer-facing facts the plan card must expose (target shape). */
interface CardFacts {
  readonly executionTaskId?: string
  readonly planReadyDelivered?: boolean
}
const facts = (data: EndeavourCardData): CardFacts => data as EndeavourCardData & CardFacts

type Row = { readonly running?: boolean } | undefined

/** Realistic slice of the official SessionListState used by the fixtures. */
interface FixtureSessions {
  readonly ids: string[]
  readonly byId: Record<string, { id: string; displayTitle: string; running: boolean; blank: boolean; updatedAt: number }>
  readonly current: string
  readonly phase: 'pending' | 'ready'
  readonly subagentsByParent: Record<string, never>
  readonly jobsBySession: Record<string, never>
  readonly currentAddress: undefined
}

const sessionState = (rows: Record<string, Row>, phase: 'pending' | 'ready'): FixtureSessions => ({
  ids: Object.keys(rows),
  byId: Object.fromEntries(Object.entries(rows)
    .filter(([, row]) => row !== undefined)
    .map(([id, row]) => [id, { id, displayTitle: id, running: row?.running === true, blank: false, updatedAt: 1 }])),
  current: ROOT,
  phase,
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
})

/** `useSessions` stub: a plain selector over a fixed snapshot. */
const sessions = (state: unknown) => <T,>(select: (snapshot: never) => T): T => select(state as never)

function renderDock(data: EndeavourCardData, state: FixtureSessions): string {
  return renderToStaticMarkup(createElement(PlanDock, {
    useProjection: (key: string) => (key === 'endeavourPlan' ? data : undefined),
    useSessions: sessions(state),
    t: undefined,
    openCounterpart: () => undefined,
    currentSessionId: ROOT,
  } as never))
}

function renderCard(data: EndeavourCardData, state: FixtureSessions): string {
  return renderToStaticMarkup(createElement(PlanCard, {
    node: { data },
    useSessions: sessions(state),
    t: undefined,
    openCounterpart: () => undefined,
    currentSessionId: ROOT,
  } as never))
}

/** The same delivered plan with its first task started (Working). */
function workingPlan(): PlanState {
  const plan = deliveredPeerPlan()
  return { ...plan, tasks: [{ ...plan.tasks[0]!, status: 'running' as const, startedAt: 1_000 }, plan.tasks[1]!] }
}

const STOPPED = 'Challenger stopped'

describe('plan projection exposes live execution facts', () => {
  it('reports the current unreported task and a delivered plan-ready relay', () => {
    const card = projectPlanCard(deliveredPeerPlan())
    expect(facts(card).executionTaskId).toBe('t1')
    expect(facts(card).planReadyDelivered).toBe(true)
  })

  it('leaves the delivered flag false before the relay settles', () => {
    const plan = createPlanState({
      planId: PlanId('p2'), rootSessionId: ROOT, challengerSessionId: CHALLENGER, pairId: PAIR,
      title: 'Fresh plan', tasks: [spec('t1')], at: 1_000,
    })
    const card = projectPlanCard(markDeliveryPending(
      plan, { kind: 'plan-ready', key: `${PAIR}:p2:plan-ready`, at: 1_000, targetSessionId: CHALLENGER }, 1_000,
    ))
    expect(facts(card).planReadyDelivered).toBe(false)
    expect(facts(card).executionTaskId).toBe('t1')
  })
})

describe('interruption detection', () => {
  it('shows the running row untouched while the Challenger keeps running', () => {
    const html = renderDock(projectPlanCard(workingPlan()), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: true } }, 'ready'))
    expect(html).toContain('Working')
    expect(html).not.toContain(STOPPED)
  })

  it('marks the current row when the Challenger stops mid-task, on both surfaces', () => {
    const data = projectPlanCard(workingPlan())
    const state = sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready')
    const dock = renderDock(data, state)
    const card = renderCard(data, state)
    for (const html of [dock, card]) {
      expect(html).toContain(STOPPED)
      expect(html).toContain('data-endeavour-interrupted')
    }
    // Only the DISPLAY is overridden: the durable task status is untouched.
    expect(data.tasks[0]?.status).toBe('running')
    expect(data.tasks[1]?.status).toBe('waiting')
    expect(data.tasks[0]?.stage).toBe('working')
  })

  it('marks the first task when the Challenger stops before it starts', () => {
    const plan = deliveredPeerPlan()
    const waiting = { ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: 'waiting' as const })) }
    const html = renderDock(projectPlanCard(waiting), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(html).toContain('Waiting to start')
    expect(html).toContain(STOPPED)
  })

  it('marks the next waiting task when the Challenger stops between tasks', () => {
    const plan = deliveredPeerPlan()
    const reported = {
      ...plan,
      tasks: [
        { ...plan.tasks[0]!, status: 'running' as const, startedAt: 1_000, report: { summary: 'one', files: [], validation: 'ok', reportedAt: 2_000 } },
        { ...plan.tasks[1]!, status: 'waiting' as const },
      ],
    }
    const html = renderDock(projectPlanCard(reported), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(html).toContain('Finished')
    expect(html).toContain(STOPPED)
  })

  it('marks the row when the Challenger row disappears from a ready list', () => {
    const html = renderDock(projectPlanCard(deliveredPeerPlan()), sessionState({ [ROOT]: {} }, 'ready'))
    expect(html).toContain(STOPPED)
  })

  it('stays silent while the session list is still pending', () => {
    const html = renderDock(projectPlanCard(deliveredPeerPlan()), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'pending'))
    expect(html).not.toContain(STOPPED)
  })

  it('stays silent before the plan was delivered', () => {
    const plan = deliveredPeerPlan()
    const undelivered = { ...plan, deliveries: (plan.deliveries ?? []).map((fact) => ({ ...fact, status: 'pending' as const })) }
    const html = renderDock(projectPlanCard(undelivered), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(html).not.toContain(STOPPED)
  })

  it('stays silent while Endeavour reviews and after the plan is terminal', () => {
    const plan = deliveredPeerPlan()
    const reported = {
      ...plan,
      tasks: plan.tasks.map((task) => ({
        ...task, status: 'running' as const, startedAt: 1_000,
        report: { summary: 'done', files: [], validation: 'ok', reportedAt: 2_000 },
      })),
    }
    const review = renderDock(projectPlanCard(reported), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(review).not.toContain(STOPPED)
    const terminal = { ...plan, terminal: { outcome: 'completed' as const, at: 3_000 } }
    const done = renderDock(projectPlanCard(terminal), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(done).not.toContain(STOPPED)
  })

  it('stays silent for a legacy plan without a peer', () => {
    const { challengerSessionId: _peer, pairId: _pair, ...peerless } = deliveredPeerPlan()
    const legacy: PlanState = { ...peerless, childId: 'child-legacy' }
    const html = renderDock(projectPlanCard(legacy), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(html).not.toContain(STOPPED)
  })
})

describe('activity selector transitions', () => {
  const card = () => projectPlanCard(deliveredPeerPlan())

  it('moves running -> interrupted -> running as the session list changes', () => {
    const data = card()
    expect(challengerActivity(data, sessionState({ [ROOT]: {}, [CHALLENGER]: { running: true } }, 'ready'))).toBe('running')
    expect(challengerActivity(data, sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))).toBe('interrupted')
    expect(challengerActivity(data, sessionState({ [ROOT]: {}, [CHALLENGER]: { running: true } }, 'ready'))).toBe('running')
    // Missing row in a ready list is an interruption; a pending list claims nothing.
    expect(challengerActivity(data, sessionState({ [ROOT]: {} }, 'ready'))).toBe('interrupted')
    expect(challengerActivity(data, sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'pending'))).toBe('unknown')
    expect(challengerActivity(data, undefined)).toBe('unknown')
  })

  it('is inactive outside live peer execution', () => {
    const plan = deliveredPeerPlan()
    const undelivered = { ...plan, deliveries: (plan.deliveries ?? []).map((fact) => ({ ...fact, status: 'pending' as const })) }
    expect(challengerActivity(projectPlanCard(undelivered), sessionState({}, 'ready'))).toBe('inactive')
    const reported = { ...plan, tasks: plan.tasks.map((task) => ({ ...task, status: 'running' as const, report: { summary: 'x', files: [], validation: 'y', reportedAt: 2_000 } })) }
    expect(challengerActivity(projectPlanCard(reported), sessionState({}, 'ready'))).toBe('inactive')
    expect(challengerActivity(projectPlanCard({ ...plan, terminal: { outcome: 'completed', at: 3 } }), sessionState({}, 'ready'))).toBe('inactive')
    const { challengerSessionId: _p, pairId: _q, ...peerless } = plan
    expect(challengerActivity(projectPlanCard({ ...peerless, childId: 'child' }), sessionState({}, 'ready'))).toBe('inactive')
  })

  it('leaves the durable plan schema and event payloads untouched', () => {
    const domain = readFileSync('src/domain.ts', 'utf8')
    expect(domain).not.toContain('executionTaskId')
    expect(domain).not.toContain('planReadyDelivered')
    const payload = Object.keys(planEventPayload('task-started', undefined, deliveredPeerPlan(), 1)).sort()
    expect(payload).toEqual(['at', 'kind', 'plan'])
  })
})

describe('interruption presentation details', () => {
  const stopped = (data: EndeavourCardData) => sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready')

  it('keeps the timer on an interrupted started task and exposes stable markers', () => {
    const data = projectPlanCard(workingPlan())
    const dock = renderDock(data, stopped(data))
    // The durable task is still running, so its elapsed timer keeps rendering.
    expect(dock).toMatch(/class="dsh-endeavour-row-timer"[^>]*>\d+:\d{2}</)
    expect(data.tasks[0]?.status).toBe('running')
    expect(data.tasks[0]?.finishedAt).toBeUndefined()
    // Stable evidence for tests: the row and the mark both carry the marker,
    // while the glyph itself stays decorative.
    expect(dock).toContain('data-endeavour-interrupted')
    expect(dock).toMatch(/data-endeavour-interrupted=""[^>]*aria-hidden|aria-hidden="true"[^>]*data-endeavour-interrupted/)
  })

  it('never leaks failure detail into the composer dock', () => {
    const plan = workingPlan()
    const withNote = {
      ...plan,
      tasks: [{ ...plan.tasks[0]!, status: 'failed' as const, finishedAt: 2_000, note: 'Verification did not pass' }, plan.tasks[1]!],
    }
    const dock = renderDock(projectPlanCard(withNote), sessionState({ [ROOT]: {}, [CHALLENGER]: { running: false } }, 'ready'))
    expect(dock).not.toContain('Verification did not pass')
  })

  it('parity: dock and card show the same interruption mark', () => {
    const data = projectPlanCard(workingPlan())
    const state = stopped(data)
    const dock = renderDock(data, state)
    const card = renderCard(data, state)
    for (const html of [dock, card]) {
      expect(html).toContain('Challenger stopped')
      expect(html).toContain('dsh-endeavour-glyph--interrupted')
    }
  })
})

describe('requested status colours', () => {
  it('maps working to blue, finished to green, confirmed to violet and interruption to orange', () => {
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--running \{[^}]*color: var\(--dsw-alias-state-business-primary\)/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--finished \{ color: var\(--dsw-alias-state-success-primary\); \}/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--succeeded \{ color: rgb\(167, 139, 250\); \}/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--interrupted \{ color: var\(--dsw-alias-state-warn-primary\); \}/)
    // Waiting stays gray and Failed stays red.
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--pending \{ color: var\(--dsw-alias-label-caption\); \}/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--failed \{ color: var\(--dsw-alias-state-error-primary\); \}/)
  })

  it('keeps the animated ring only on Working and disables it under reduced motion', () => {
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--running \{[^}]*animation: dsh-endeavour-spin/)
    expect(STYLE_TEXT).toMatch(/prefers-reduced-motion[\s\S]*animation: none/)
    expect(STYLE_TEXT).not.toMatch(/glyph--interrupted[^{]*\{[^}]*animation/)
  })

  it('draws the interruption mark as a circled exclamation', () => {
    const view = readFileSync('src/client/PlanView.tsx', 'utf8')
    expect(view).toContain('function InterruptedGlyph')
    expect(view).toContain('data-endeavour-interrupted')
  })
})
