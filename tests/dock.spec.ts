/**
 * Composer plan dock and English-only regressions.
 *
 * These fail the previous behavior: no dock registration, Russian status copy,
 * and prompts without the English requirement.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { en, formatEnglish } from '../src/client/locales.js'
import { copyFrom } from '../src/client/PlanCard.js'
import { latestPlanNode, PLAN_DOCK_ID, PLAN_DOCK_ORDER, PlanDock, registerPlanDock, selectPlanNode } from '../src/client/PlanDock.js'
import { PlanView } from '../src/client/PlanView.js'
import type { EndeavourCardData } from '../src/client/definition.js'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'

const planData: EndeavourCardData = {
  planId: 'p1',
  title: 'Endeavour plan: fix composer dock',
  tasks: [
    { id: 't1', title: 'Harden the receiver path for proxied service calls', status: 'succeeded', startedAt: 1_000, finishedAt: 61_000 },
    { id: 't2', title: 'A very long task title that must ellipsize inside the bounded dock body without wrapping to a second line', status: 'running', startedAt: 100_000 },
    { id: 't3', title: 'Pending task', status: 'waiting' },
  ],
  completedCount: 1,
  total: 3,
  currentTitle: 'A very long task title that must ellipsize inside the bounded dock body without wrapping to a second line',
  checking: true,
  childId: 'child-1',
}

function node(kind: string, data: unknown): ChatConversationViewNode {
  return { key: `${kind}-key`, kind, id: `${kind}-id`, target: 'chat', anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible', data } as unknown as ChatConversationViewNode
}

function markup(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element)
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
    expect(calls.registered?.order).toBe(PLAN_DOCK_ORDER)
    expect(Number(calls.registered?.order)).toBeLessThan(0)
  })

  it('selects the latest plan node and ignores other kinds or empty chats', () => {
    expect(latestPlanNode([])).toBeUndefined()
    expect(selectPlanNode({ nodes: { values: () => [node('todo', {}), node('command', {})] } })).toBeUndefined()
    const older = node('endeavour-plan', { ...planData, planId: 'old' })
    const newer = node('endeavour-plan', { ...planData, planId: 'new' })
    expect((latestPlanNode([older, node('todo', {}), newer])?.data as EndeavourCardData | undefined)?.planId).toBe('new')
  })

  it('renders all rows, English states, elapsed and frozen timers, and the open action', () => {
    const html = markup(createElement(PlanDock, {
      useChat: (selector: (snapshot: unknown) => unknown) => selector({ nodes: { values: () => [node('endeavour-plan', planData)] } }),
      t: undefined,
      openSession: () => undefined,
    } as never))
    expect(html).toContain('Endeavour plan: fix composer dock')
    expect(html).toContain('Completed 1 of 3')
    expect(html).toContain('Waiting to start')
    expect(html).toContain('Running')
    expect(html).toContain('Succeeded')
    expect(html).toContain('01:00')          // frozen terminal duration
    expect(html).toContain('Endeavour is checking the result')
    expect(html).toContain('Open Builder')
    expect(html).toContain('data-endeavour-surface="dock"')
    expect(html).toContain('text-overflow:ellipsis')
    expect(html).toContain('max-height:240px')
    // Detailed execution projections must never reach either surface.
    expect(html).not.toContain('instructions')
    expect(html).not.toContain('validation')
  })

  it('renders nothing in standard or Builder chats (no plan node)', () => {
    const html = markup(createElement(PlanDock, {
      useChat: (selector: (snapshot: unknown) => unknown) => selector({ nodes: { values: () => [] } }),
      t: undefined,
      openSession: () => undefined,
    } as never))
    expect(html).toBe('')
  })

  it('produces English copy for every locale seat and the fallback', () => {
    const english = copyFrom({ t: (key: string) => (key === 'plan.openBuilder' ? 'Open Builder' : undefined) })
    expect(english('plan.openBuilder')).toBe('Open Builder')
    const fallback = copyFrom({})
    expect(fallback('plan.completed')).toBe('Plan completed')
    expect(formatEnglish('plan.progress', { completed: 1, total: 2 })).toBe('Completed 1 of 2')
    // Both registered locale dictionaries are English.
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('renders the same view in the transcript card variant', () => {
    const html = markup(createElement(PlanView, {
      data: planData,
      copy: (key: 'plan.title') => key,
      onOpenBuilder: () => undefined,
      variant: 'card',
    } as never))
    expect(html).toContain('data-endeavour-surface="card"')
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
