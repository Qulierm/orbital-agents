// @vitest-environment happy-dom
/**
 * Composer plan dock, addressed Builder navigation, attached-geometry,
 * five-stage presentation, dock/card note split, plan-replacement expansion,
 * and English-only regressions.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { en, formatEnglish } from '../src/client/locales.js'
import { cardExecutorId, copyFrom } from '../src/client/PlanCard.js'
import { PLAN_DOCK_ID, PLAN_DOCK_ORDER, PlanDock, registerPlanDock } from '../src/client/PlanDock.js'
import { planAction } from '../src/client/plan-action.js'
import { initialCollapsed, PlanView, shouldAutoCollapse } from '../src/client/PlanView.js'
import { CLASS, ensurePlanStyles, STYLE_ELEMENT_ID, STYLE_TEXT } from '../src/client/styles.js'
import type { EndeavourCardData } from '../src/plan-projection.js'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const planData: EndeavourCardData = {
  planId: 'p1',
  rootSessionId: 'root-session',
  title: 'Extension Test Plan',
  tasks: [
    { id: 't1', title: 'Define test scope', status: 'succeeded', stage: 'confirmed', startedAt: 1_000, finishedAt: 61_000 },
    { id: 't2', title: 'Add test fixture for the attached composer dock geometry', status: 'running', stage: 'working', startedAt: 100_000 },
    { id: 't3', title: 'Verify and summarize', status: 'running', stage: 'finished', startedAt: 200_000, reportedAt: 260_000 },
    { id: 't4', title: 'Pending task', status: 'waiting', stage: 'waiting' },
  ],
  completedCount: 1,
  total: 4,
  currentTitle: 'Add test fixture for the attached composer dock geometry',
  checking: true,
  childId: 'child-session',
}

function renderDock(data: EndeavourCardData | null | undefined, currentSessionId?: string): string {
  return renderToStaticMarkup(createElement(PlanDock, {
    useProjection: (key: string) => (key === 'endeavourPlan' ? (data ?? null) : undefined),
    t: undefined,
    openCounterpart: () => undefined,
    ...(currentSessionId === undefined ? {} : { currentSessionId }),
  } as never))
}

/** Transcript-card surface, used to prove the note split against the dock. */
function renderCard(data: EndeavourCardData): string {
  return renderToStaticMarkup(createElement(PlanView, {
    data,
    copy: copyFrom({}),
    onOpenBuilder: () => undefined,
    variant: 'card',
  } as never))
}

/** One row per display stage, including a failed task carrying a reason. */
const allStages: EndeavourCardData = {
  ...planData,
  tasks: [
    { id: 's1', title: 'Waiting task', status: 'waiting', stage: 'waiting' },
    { id: 's2', title: 'Working task', status: 'running', stage: 'working', startedAt: 1_000 },
    { id: 's3', title: 'Finished task', status: 'running', stage: 'finished', startedAt: 1_000, reportedAt: 2_000 },
    { id: 's4', title: 'Confirmed task', status: 'succeeded', stage: 'confirmed', startedAt: 1_000, finishedAt: 2_000 },
    { id: 's5', title: 'Failed task', status: 'failed', stage: 'failed', startedAt: 1_000, finishedAt: 2_000, note: 'Verification did not pass' },
  ],
  completedCount: 1,
  total: 5,
  checking: false,
}

/** Render the fallback with a fixed pair observable and optional plan source. */
describe('role-aware plan action', () => {
  const peerCard = { ...planData, challengerSessionId: 'challenger-x', pairId: 'pair-x' } as EndeavourCardData

  it('resolves the exact counterpart per role and never itself', () => {
    expect(planAction(peerCard, 'session-root')).toEqual({ kind: 'peer', target: 'challenger-x', role: 'challenger' })
    expect(planAction(peerCard, 'challenger-x')).toEqual({ kind: 'peer', target: 'root-session', role: 'endeavour' })
    // Malformed peer data on the Challenger degrades to history, never self.
    expect(planAction({ ...peerCard, rootSessionId: 'challenger-x' }, 'challenger-x')).toEqual({ kind: 'legacy' })
  })

  it('keeps a historical childId-only card as disabled history', () => {
    expect(planAction(planData, 'session-root')).toEqual({ kind: 'legacy' })
    expect(planAction(planData, 'child-session')).toEqual({ kind: 'legacy' })
  })

  it('renders Open Challenger on the root and Open Endeavour on the peer', () => {
    const rootHtml = renderDock(peerCard, 'session-root')
    expect(rootHtml).toContain('Open Challenger')
    expect(rootHtml).not.toContain('disabled=""')
    const peerHtml = renderDock(peerCard, 'challenger-x')
    expect(peerHtml).toContain('Open Endeavour')
    expect(peerHtml).not.toContain('Open Challenger')
  })
})

describe('composer plan dock', () => {
  it('registers on conversation.input.dock with a stable id and injected navigation', () => {
    const calls: { injected?: string; options?: Record<string, unknown>; props?: unknown } = {}
    registerPlanDock({
      inject(name, callback) { calls.injected = name; callback() },
      register(options) { calls.options = options as unknown as Record<string, unknown> },
    }, () => ({ openCounterpart: () => { calls.props = 'openCounterpart' } }))
    expect(calls.injected).toBe('conversation.input.dock')
    expect(calls.options?.name).toBe('conversation.input.dock')
    expect(calls.options?.id).toBe(PLAN_DOCK_ID)
    // Last occupant before InputBar: a deliberate very-high finite order above
    // dsh-cost-meter (5) and native todo (0); sorting stays stable.
    expect(Number(calls.options?.order)).toBe(PLAN_DOCK_ORDER)
    expect(PLAN_DOCK_ORDER).toBeGreaterThan(5)
    expect(PLAN_DOCK_ORDER).toBeGreaterThan(0)
    expect(Number.isFinite(PLAN_DOCK_ORDER)).toBe(true)
    expect(typeof calls.options?.inject).toBe('function')
    expect((calls.options?.inject as () => unknown)()).toMatchObject({ openCounterpart: expect.any(Function) })
  })

  it('renders only from the projected durable plan and nothing without it', () => {
    expect(renderDock(null)).toBe('')
    expect(renderDock(undefined)).toBe('')
    expect(renderDock({ ...planData, planId: 'projected-old' })).toContain('data-endeavour-plan="projected-old"')
  })

  it('renders all five stages in English with concise progress and no completion footer', () => {
    const html = renderDock(planData)
    expect(html).toContain('Extension Test Plan')
    expect(html).toContain('1 / 4 confirmed')
    expect(html).toContain('Waiting to start')
    expect(html).toContain('Working')
    expect(html).toContain('Finished')
    expect(html).toContain('Confirmed')
    expect(html).toContain(CLASS.glyphFinished)
    expect(html).toContain(`${CLASS.row} ${CLASS.rowRunning}`)
    expect(html).toContain(CLASS.ghost)
    // The fixture is a LEGACY card: the action is disabled and history is
    // reachable through native Subagents instead of the peer tab.
    expect(html).toContain('Open Builder')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Plan completed')
    expect(html).not.toContain('●')
    expect(html).not.toContain('instructions')
    expect(html).not.toContain('validation')
  })

  it('freezes Finished at the Builder report while the persisted status stays running', () => {
    const html = renderDock(planData)
    // t3 started at 200000 and reported at 260000 -> frozen 01:00.
    expect(html).toContain('01:00')
  })

  it('paints Finished green, Working blue, Confirmed violet, and leaves Waiting and Failed alone', () => {
    const html = renderDock(allStages)
    // Finished now shares the Confirmed check-ring geometry, so the same path
    // appears exactly twice in this fixture (finished + confirmed) and the
    // retired finish flag is gone entirely.
    const ring = html.split('M4.4 7.2 6.2 9l3.6-3.8').length - 1
    expect(ring).toBe(2)
    expect(html).not.toContain('M4 1.8v10.4')
    expect(html).not.toContain('M4 2.6h6.6l-1.6 2.6 1.6 2.6H4z')
    // The long-retired neutral Finished check stays gone.
    expect(html).not.toContain('M4.6 7.1 6.2 8.7')
    // The failed cross and the working pulse are untouched.
    expect(html).toContain('M5 5l4 4M9 5l-4 4')
    expect(html).toContain(CLASS.pulse)
    // Colour tokens keep the stages distinct: green finished, blue running,
    // violet confirmed, red failed, gray waiting.
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--running \{\s*color: var\(--dsw-alias-state-business-primary\);\s*animation: dsh-endeavour-spin 1s linear infinite;/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--finished \{ color: var\(--dsw-alias-state-success-primary\); \}/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--succeeded \{ color: rgb\(167, 139, 250\); \}/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-glyph--failed \{ color: var\(--dsw-alias-state-error-primary\); \}/)
    expect(STYLE_TEXT).not.toMatch(/glyph--finished \{ color: var\(--dsw-alias-label-secondary\)/)
    expect(STYLE_TEXT).not.toMatch(/glyph--running \{\s*color: var\(--dsw-alias-state-warn-primary\)/)
  })

  it('hides the failure reason in the composer dock and keeps it on the transcript card', () => {
    const dock = renderDock(allStages)
    expect(dock).toContain(CLASS.glyphFailed)
    expect(dock).toContain('Failed')
    expect(dock).not.toContain('Verification did not pass')
    const card = renderCard(allStages)
    expect(card).toContain(CLASS.glyphFailed)
    expect(card).toContain('Failed')
    expect(card).toContain('Verification did not pass')
    expect(card).not.toContain('Plan failed')
  })

  it('keeps the peer action enabled for canonical peer plans', () => {
    const peerCard = { ...planData, challengerSessionId: 'challenger-x', pairId: 'pair-x' } as typeof planData
    const html = renderDock(peerCard)
    expect(html).toContain('Open Challenger')
    expect(html).not.toContain('disabled=""')
  })

  it('derives the executor session and stays safe when identity is missing', () => {
    // Peer plans resolve to the persistent Challenger; legacy cards fall back
    // to the historical child id; malformed identity is a no-op.
    expect(cardExecutorId(planData)).toBe(planData.challengerSessionId ?? planData.childId)
    const { challengerSessionId: _peer, ...legacy } = planData
    expect(cardExecutorId({ ...legacy, childId: 'child-session' })).toBe('child-session')
    expect(cardExecutorId({ ...legacy, childId: '' })).toBeUndefined()
    expect(cardExecutorId({ ...planData, rootSessionId: '' })).toBeUndefined()
    expect(cardExecutorId({ ...planData, rootSessionId: undefined as never })).toBeUndefined()
  })
})


describe('plan collapse lifecycle', () => {
  it('starts completed plans collapsed and active or failed plans expanded', () => {
    expect(initialCollapsed(true)).toBe(true)
    expect(initialCollapsed(false)).toBe(false)
  })

  it('auto-collapses once on a terminal transition and persists a manual reopen', () => {
    // Transition to completed: collapse exactly once.
    expect(shouldAutoCollapse(false, true, false)).toBe(true)
    // Settled terminal state no longer collapses (manual reopen stays open).
    expect(shouldAutoCollapse(true, true, true)).toBe(false)
    // Repeated renders while terminal never trigger another collapse.
    expect(shouldAutoCollapse(true, true, false)).toBe(false)
    // Active and failed plans never auto-collapse.
    expect(shouldAutoCollapse(false, false, false)).toBe(false)
  })

  it('renders collapsed markup for a completed plan and rows for an active plan', () => {
    const completed: EndeavourCardData = {
      ...planData,
      tasks: planData.tasks.map((task) => ({ ...task, status: 'succeeded', stage: 'confirmed' as const })),
      completedCount: planData.total,
      terminal: { outcome: 'completed', at: 1 },
    }
    const collapsedHtml = renderDock(completed)
    expect(collapsedHtml).toContain('4 / 4 confirmed')
    expect(collapsedHtml).not.toContain(CLASS.rows)
    expect(collapsedHtml).toContain(CLASS.ghost)
    const activeHtml = renderDock(planData)
    expect(activeHtml).toContain(CLASS.rows)
  })
})

describe('plan replacement in a mounted dock', () => {
  const roots: Root[] = []
  const containers: HTMLElement[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => { root.unmount() })
    for (const container of containers.splice(0)) container.remove()
  })

  function mountDock(): { container: HTMLElement; show: (data: EndeavourCardData) => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    containers.push(container)
    const show = (data: EndeavourCardData): void => {
      root.render(createElement(PlanDock, {
        useProjection: (key: string) => (key === 'endeavourPlan' ? data : undefined),
        t: undefined,
        openCounterpart: () => undefined,
      } as never))
    }
    return { container, show }
  }

  const rows = (container: HTMLElement): Element | null => container.querySelector(`.${CLASS.rows}`)
  const toggle = (container: HTMLElement): void => {
    const chevron = container.querySelector(`.${CLASS.chevron}`) as HTMLButtonElement
    act(() => { chevron.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }

  it('opens the dock when a different plan id replaces the current one', () => {
    const { container, show } = mountDock()
    act(() => { show({ ...planData, planId: 'plan-a' }) })
    expect(container.querySelector('[data-endeavour-plan="plan-a"]')).not.toBeNull()
    expect(rows(container)).not.toBeNull()

    // A manual collapse inside THIS plan is respected by further re-renders.
    toggle(container)
    expect(rows(container)).toBeNull()
    act(() => { show({ ...planData, planId: 'plan-a' }) })
    expect(rows(container)).toBeNull()

    // A different plan always opens, even though the user had collapsed the
    // previous one in the same mounted dock.
    act(() => { show({ ...planData, planId: 'plan-b' }) })
    expect(container.querySelector('[data-endeavour-plan="plan-b"]')).not.toBeNull()
    expect(rows(container)).not.toBeNull()

    // And the same-plan manual collapse still works for the new plan.
    toggle(container)
    expect(rows(container)).toBeNull()
  })
})

describe('attached composer stylesheet', () => {
  it('matches the InputBar width axis exactly (no dock inset)', () => {
    expect(STYLE_TEXT).toContain('var(--dsh-composer-side-clearance)')
    expect(STYLE_TEXT).toContain('var(--dsh-composer-card-max-width)')
    expect(STYLE_TEXT).not.toContain('composer-dock-inset')
    expect(STYLE_TEXT).toContain('calc(0px - var(--dsh-composer-stack-gap) - 3px)')
  })

  it('uses the composer input surface, stroke, radius, and elevation', () => {
    expect(STYLE_TEXT).toContain('background: var(--dsw-specific-input-major)')
    expect(STYLE_TEXT).toContain('border-radius: 22px 22px 0 0')
    // Borderless like the input: no dock stroke token, no panel stroke
    // overlay, no independent elevation on the dock (the composer keeps its own).
    expect(STYLE_TEXT).not.toContain('var(--dsw-alias-border-l2)')
    expect(STYLE_TEXT).not.toContain('.dsh-endeavour-dock-panel::after')
    expect(STYLE_TEXT).not.toMatch(/\.dsh-endeavour-dock-panel \{[^}]*box-shadow/)
    expect(STYLE_TEXT).not.toContain('.dsh-endeavour-dock-wrap::after')
    // The standalone transcript card keeps its own surface.
    expect(STYLE_TEXT).toContain('background: var(--dsw-specific-tip)')
    expect(STYLE_TEXT).not.toContain('--dsw-text-primary')
    expect(STYLE_TEXT).not.toContain('--dsw-surface-raised')
  })




  it('keeps the expanded panel compact', () => {
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-header \{[^}]*height: 32px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-row \{[^}]*min-height: 27px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-rows \{[^}]*gap: 2px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-dock-panel \{[^}]*padding: 1px 0 1px/)
  })

  it('connects the junction through the stable composer anchors only', () => {
    const scoped = '[data-composer-seat]:has(.dsh-endeavour-dock-wrap) [data-composer-card]'
    expect(STYLE_TEXT).toContain(scoped)
    expect(STYLE_TEXT).toContain('border-top-left-radius: 0')
    expect(STYLE_TEXT).toContain('border-top-right-radius: 0')
    // Connected mode drops the card's native elevation entirely and uses no
    // junction pseudo-element, so both halves share one borderless edge.
    const block = STYLE_TEXT.slice(STYLE_TEXT.indexOf(scoped), STYLE_TEXT.indexOf('}', STYLE_TEXT.indexOf(scoped)))
    expect(block).toContain('box-shadow: none')
    expect(STYLE_TEXT).not.toContain('[data-composer-card]::before')
    // No standalone (unscoped) card mutation: normal composers keep their native elevation.
    expect(/^\[data-composer-card\] \{/m.test(STYLE_TEXT)).toBe(false)
  })

  it('keeps the expanded panel compact', () => {
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-header \{[^}]*height: 32px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-row \{[^}]*min-height: 27px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-rows \{[^}]*gap: 2px/)
    expect(STYLE_TEXT).toMatch(/\.dsh-endeavour-dock-panel \{[^}]*padding: 1px 0 1px/)
  })

  it('carries working motion, a distinct finished glyph, and reduced-motion off-switch', () => {
    expect(STYLE_TEXT).toContain('dsh-endeavour-spin')
    expect(STYLE_TEXT).toContain('dsh-endeavour-pulse')
    expect(STYLE_TEXT).toContain('dsh-endeavour-glyph--finished')
    expect(STYLE_TEXT).toContain('@media (prefers-reduced-motion: reduce)')
    expect(STYLE_TEXT).toMatch(/prefers-reduced-motion[\s\S]*animation: none/)
    expect(STYLE_TEXT).not.toMatch(/glyph--finished[^{]*{[^}]*animation/)
  })

  it('injects exactly one tagged element and disposes it', () => {
    const created: { node?: { id?: string; textContent?: string }; removed: boolean } = { removed: false }
    const existing = globalThis.document
    try {
      const styleNode = { id: '', textContent: '', setAttribute: () => {}, remove: () => { created.removed = true } }
      ;(globalThis as { document?: unknown }).document = {
        head: { appendChild: (node: { id?: string }) => { created.node = node } },
        getElementById: () => null,
        createElement: () => styleNode,
      }
      const dispose = ensurePlanStyles()
      expect(created.node?.id).toBe(STYLE_ELEMENT_ID)
      expect(styleNode.textContent).toBe(STYLE_TEXT)
      dispose()
      expect(created.removed).toBe(true)
    } finally {
      ;(globalThis as { document?: unknown }).document = existing
    }
  })
})

describe('English copy and planning prompts', () => {
  it('produces English copy for every locale seat and the fallback', () => {
    expect(copyFrom({})('stage.confirmed')).toBe('Confirmed')
    expect(copyFrom({ t: (key: string) => (key === 'plan.openBuilder' ? 'Open Builder' : undefined) })('plan.openBuilder')).toBe('Open Builder')
    expect(formatEnglish('plan.progress', { confirmed: 1, total: 2 })).toBe('1 / 2 confirmed')
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('requires a detailed, decision-complete plan in the Endeavour prompt', () => {
    const prompt = readFileSync('src/prompts/endeavour.md', 'utf8')
    for (const section of ['Objective', 'Current State Analysis', 'Risks and Considerations', 'Implementation Plan', 'Builder Tasks', 'Validation Checklist', 'Definition of Done']) {
      expect(prompt).toContain(section)
    }
    expect(prompt).toMatch(/4[–-]10 granular tasks/i)
    expect(prompt).toMatch(/1:1/i)
    expect(prompt).toMatch(/never collapse/i)
    expect(prompt).toMatch(/always written in English/i)
  })

  it('requires the Challenger executor contract in English', () => {
    const prompt = readFileSync('src/prompts/challenger.md', 'utf8')
    expect(prompt).toMatch(/written in English/i)
    expect(prompt).toMatch(/verbatim command output/i)
    expect(prompt).toMatch(/whole-plan brief from Endeavour/i)
    expect(prompt).toMatch(/Execute the tasks of the current plan in order/i)
    expect(prompt).toMatch(/continue\s+directly with the next task/i)
    expect(prompt).toMatch(/never act as\s+a subagent/i)
    expect(prompt).toMatch(/Never send ordinary messages to Endeavour/i)
    expect(prompt).toMatch(/compact/i)
  })

  it('keeps the embedded preset persona exact and its metadata English', () => {
    const prompt = readFileSync('src/prompts/endeavour.md', 'utf8')
    const preset = readFileSync('preset/endeavour/agent.cordis.yml', 'utf8')
    const indented = prompt.replace(/\n$/, '').split('\n').map((line) => (line === '' ? '' : `      ${line}`)).join('\n')
    expect(preset).toContain(`    prefix: |\n${indented}\n`)
    const metadata = readFileSync('preset/endeavour/preset.yml', 'utf8')
    expect(metadata).toMatch(/^name: Endeavour$/m)
    expect(metadata).toMatch(/^description: [\x20-\x7E]+$/m)
    expect(metadata).not.toMatch(/[А-Яа-яЁё]/)
  })
})
