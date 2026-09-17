/**
 * Composer plan dock, addressed Builder navigation, attached-geometry,
 * five-stage presentation, and English-only regressions.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { en, formatEnglish } from '../src/client/locales.js'
import { builderAddress, copyFrom } from '../src/client/PlanCard.js'
import { PLAN_DOCK_ID, PLAN_DOCK_ORDER, PlanDock, registerPlanDock } from '../src/client/PlanDock.js'
import { initialCollapsed, PlanView, shouldAutoCollapse } from '../src/client/PlanView.js'
import { CLASS, ensurePlanStyles, STYLE_ELEMENT_ID, STYLE_TEXT } from '../src/client/styles.js'
import type { EndeavourCardData } from '../src/plan-projection.js'

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

function renderDock(data: EndeavourCardData | null | undefined): string {
  return renderToStaticMarkup(createElement(PlanDock, {
    useProjection: (key: string) => (key === 'endeavourPlan' ? (data ?? null) : undefined),
    t: undefined,
    openBuilder: () => undefined,
  } as never))
}

describe('composer plan dock', () => {
  it('registers on conversation.input.dock with a stable id and injected navigation', () => {
    const calls: { injected?: string; options?: Record<string, unknown>; props?: unknown } = {}
    registerPlanDock({
      inject(name, callback) { calls.injected = name; callback() },
      register(options) { calls.options = options as unknown as Record<string, unknown> },
    }, () => ({ openBuilder: () => { calls.props = 'openBuilder' } }))
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
    expect((calls.options?.inject as () => unknown)()).toEqual({ openBuilder: expect.any(Function) })
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
    expect(html).toContain('Open Builder')
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

  it('renders a failed task with its note and red glyph, without a generic sentence', () => {
    const failed: EndeavourCardData = {
      ...planData,
      tasks: [{ id: 'f1', title: 'Broken task', status: 'failed', stage: 'failed', startedAt: 0, finishedAt: 5_000, note: 'Verification did not pass' }],
      completedCount: 0,
      total: 1,
      checking: false,
    }
    const html = renderDock(failed)
    expect(html).toContain(CLASS.glyphFailed)
    expect(html).toContain('Failed')
    expect(html).toContain('Verification did not pass')
    expect(html).not.toContain('Plan failed')
  })

  it('builds the exact continuable address and stays safe when identity is missing', () => {
    expect(builderAddress(planData)).toEqual({
      parentSessionId: 'root-session', childSessionId: 'child-session', mode: 'continuable',
    })
    expect(builderAddress({ ...planData, rootSessionId: '' })).toBeUndefined()
    expect(builderAddress({ ...planData, childId: '' })).toBeUndefined()
    expect(builderAddress({ ...planData, rootSessionId: undefined as never })).toBeUndefined()
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

  it('requires English Builder prose, one-task execution, and compact evidence', () => {
    const prompt = readFileSync('src/prompts/builder.md', 'utf8')
    expect(prompt).toMatch(/all of your prose in English/i)
    expect(prompt).toMatch(/verbatim command output are exempt/i)
    expect(prompt).toMatch(/Execute only the task that is currently running/i)
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
