/**
 * Composer plan dock, attached-geometry, motion, and English-only regressions.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { en, formatEnglish } from '../src/client/locales.js'
import { copyFrom } from '../src/client/PlanCard.js'
import { latestPlanNode, PLAN_DOCK_ID, PLAN_DOCK_ORDER, PlanDock, registerPlanDock, selectPlanNode } from '../src/client/PlanDock.js'
import { PlanView } from '../src/client/PlanView.js'
import { CLASS, ensurePlanStyles, STYLE_ELEMENT_ID, STYLE_TEXT } from '../src/client/styles.js'
import type { EndeavourCardData } from '../src/client/definition.js'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'

const planData: EndeavourCardData = {
  planId: 'p1',
  title: 'Extension Test Plan',
  tasks: [
    { id: 't1', title: 'Define test scope', status: 'succeeded', startedAt: 1_000, finishedAt: 61_000 },
    { id: 't2', title: 'A very long task title that must ellipsize inside the bounded dock body without wrapping', status: 'running', startedAt: 100_000 },
    { id: 't3', title: 'Verify and summarize', status: 'waiting' },
  ],
  completedCount: 1,
  total: 3,
  currentTitle: 'A very long task title that must ellipsize inside the bounded dock body without wrapping',
  checking: true,
  childId: 'child-1',
}

function node(kind: string, data: unknown): ChatConversationViewNode {
  return { key: `${kind}-key`, kind, id: `${kind}-id`, target: 'chat', anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible', data } as unknown as ChatConversationViewNode
}

function renderDock(data: EndeavourCardData | undefined): string {
  return renderToStaticMarkup(createElement(PlanDock, {
    useChat: (selector: (snapshot: unknown) => unknown) => selector({ nodes: { values: () => (data === undefined ? [] : [node('endeavour-plan', data)]) } }),
    t: undefined,
    openSession: () => undefined,
  } as never))
}

describe('composer plan dock', () => {
  it('registers on conversation.input.dock with a stable id before the todo dock', () => {
    const calls: { injected?: string; registered?: Record<string, unknown> } = {}
    registerPlanDock({} as never, {
      inject(name, callback) { calls.injected = name; callback() },
      register(options) { calls.registered = options as unknown as Record<string, unknown> },
    })
    expect(calls.injected).toBe('conversation.input.dock')
    expect(calls.registered?.name).toBe('conversation.input.dock')
    expect(calls.registered?.id).toBe(PLAN_DOCK_ID)
    expect(Number(calls.registered?.order)).toBeLessThan(0)
  })

  it('selects the latest plan node and ignores other kinds or empty chats', () => {
    expect(latestPlanNode([])).toBeUndefined()
    expect(selectPlanNode({ nodes: { values: () => [node('todo', {}), node('command', {})] } })).toBeUndefined()
    const older = node('endeavour-plan', { ...planData, planId: 'old' })
    const newer = node('endeavour-plan', { ...planData, planId: 'new' })
    expect((latestPlanNode([older, node('todo', {}), newer])?.data as EndeavourCardData | undefined)?.planId).toBe('new')
  })

  it('renders the attached dock structure with rows, English states, timers, and the ghost action', () => {
    const html = renderDock(planData)
    expect(html).toContain(CLASS.dockWrap)
    expect(html).toContain(CLASS.dockPanel)
    expect(html).toContain(`${CLASS.row} ${CLASS.rowRunning}`)
    expect(html).toContain('Extension Test Plan')
    expect(html).toContain('Completed 1 of 3')
    expect(html).toContain('Waiting to start')
    expect(html).toContain('Running')
    expect(html).toContain('Succeeded')
    expect(html).toContain('01:00')
    expect(html).toContain('Endeavour is checking the result')
    expect(html).toContain(CLASS.ghost)
    expect(html).toContain('Open Builder')
    expect(html).toContain('data-endeavour-surface="dock"')
    // Native glyphs replace the text bullet; no execution projections.
    expect(html).not.toContain('●')
    expect(html).not.toContain('instructions')
    expect(html).not.toContain('validation')
    expect(html).not.toContain('constraints')
    // No redundant current-task headline when the running row already shows it.
    expect(html).not.toContain('Current task:')
  })

  it('renders nothing in standard or Builder chats (no plan node)', () => {
    expect(renderDock(undefined)).toBe('')
  })

  it('produces English copy for every locale seat and the fallback', () => {
    const english = copyFrom({ t: (key: string) => (key === 'plan.openBuilder' ? 'Open Builder' : undefined) })
    expect(english('plan.openBuilder')).toBe('Open Builder')
    expect(copyFrom({})('plan.completed')).toBe('Plan completed')
    expect(formatEnglish('plan.progress', { completed: 1, total: 2 })).toBe('Completed 1 of 2')
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('keeps the card variant on the shared semantic content', () => {
    const html = renderToStaticMarkup(createElement(PlanView, {
      data: planData,
      copy: (key: 'plan.title') => key,
      onOpenBuilder: () => undefined,
      variant: 'card',
    } as never))
    expect(html).toContain('data-endeavour-surface="card"')
    expect(html).toContain(CLASS.header)
    expect(html).toContain(CLASS.row)
  })
})

describe('attached composer stylesheet', () => {
  it('uses the native width math, negative stack gap, and top-only radii', () => {
    expect(STYLE_TEXT).toContain('var(--dsh-composer-side-clearance)')
    expect(STYLE_TEXT).toContain('var(--dsh-composer-dock-inset)')
    expect(STYLE_TEXT).toContain('var(--dsh-composer-card-max-width)')
    expect(STYLE_TEXT).toContain('calc(0px - var(--dsh-composer-stack-gap) - 3px)')
    expect(STYLE_TEXT).toContain('border-radius: 12px 12px 0 0')
    expect(STYLE_TEXT).toContain('border-bottom: none')
  })

  it('uses current alias tokens and drops the stale surface tokens', () => {
    expect(STYLE_TEXT).toContain('var(--dsw-specific-tip)')
    expect(STYLE_TEXT).toContain('var(--dsw-alias-label-primary)')
    expect(STYLE_TEXT).toContain('var(--dsw-alias-border-l1)')
    expect(STYLE_TEXT).toContain('var(--dsw-alias-state-business-primary)')
    expect(STYLE_TEXT).toContain('var(--dsw-alias-state-success-primary)')
    expect(STYLE_TEXT).toContain('var(--dsw-alias-state-error-primary)')
    expect(STYLE_TEXT).not.toContain('--dsw-text-primary')
    expect(STYLE_TEXT).not.toContain('--dsw-surface-raised')
  })

  it('carries running motion plus a reduced-motion off-switch', () => {
    expect(STYLE_TEXT).toContain('dsh-endeavour-spin')
    expect(STYLE_TEXT).toContain('dsh-endeavour-pulse')
    expect(STYLE_TEXT).toContain('@media (prefers-reduced-motion: reduce)')
    expect(STYLE_TEXT).toMatch(/prefers-reduced-motion[\s\S]*animation: none/)
  })

  it('scopes every rule under the unique prefix and injects exactly one tagged element', () => {
    // No bare element selectors or generic classes leak outside the prefix.
    for (const rule of STYLE_TEXT.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('{'))) {
      const selector = rule.slice(0, -1).trim()
      if (selector.startsWith('@') || selector.startsWith('to') || selector.startsWith('from')) continue
      expect(selector).toContain('dsh-endeavour')
    }
    const created: { node?: { id?: string; textContent?: string }; removed: boolean } = { removed: false }
    const existing = globalThis.document
    try {
      const styleNode = { id: '', textContent: '', setAttribute: () => {}, remove: () => { created.removed = true } }
      ;(globalThis as { document?: unknown }).document = {
        head: { appendChild: (node: { id?: string; textContent?: string }) => { created.node = node } },
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
    // SSR-safe without document.
    expect(typeof ensurePlanStyles()).toBe('function')
  })
})

describe('English-requirement prompts', () => {
  it('requires English plans in the Endeavour prompt', () => {
    const prompt = readFileSync('src/prompts/endeavour.md', 'utf8')
    expect(prompt).toMatch(/always written in English/i)
    expect(prompt).toMatch(/regardless of the language/i)
  })

  it('requires English reports in the Builder prompt and exempts verbatim output', () => {
    const prompt = readFileSync('src/prompts/builder.md', 'utf8')
    expect(prompt).toMatch(/Write every report in English/i)
    expect(prompt).toMatch(/verbatim command\s+output are exempt/i)
  })

  it('keeps the embedded preset persona exactly equal to the packaged prompt', () => {
    const prompt = readFileSync('src/prompts/endeavour.md', 'utf8')
    const preset = readFileSync('preset/endeavour/agent.cordis.yml', 'utf8')
    const indented = prompt.replace(/\n$/, '').split('\n').map((line) => (line === '' ? '' : `      ${line}`)).join('\n')
    expect(preset).toContain(`    prefix: |\n${indented}\n`)
  })
})
