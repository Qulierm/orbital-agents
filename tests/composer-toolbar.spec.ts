// @vitest-environment happy-dom
/**
 * Composer toolbar composition regressions.
 *
 * The composer carries exactly ONE Endeavour model control: an icon-only
 * sliders button (`endeavour-models`, order 1000) that owns the two-role menu.
 * The host-owned native `conversation.input.model` seat is hidden by CSS only
 * while that control is rendered in the same composer card. These tests pin the
 * single registration, the icon markup and its accessible name, the injected
 * stylesheet contract, the retired split controls, and the English copy and
 * planning prompts.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { STYLE_TEXT } from '../src/client/styles.js'
import { NS, en, formatEnglish } from '../src/client/locales.js'
import { copyFrom } from '../src/client/PlanCard.js'

describe('slot registration', () => {
  it('registers exactly one unified control at the end of the right slot', async () => {
    vi.resetModules()
    const registrations: { name: string; id?: string; order?: number; locale?: string; inject?: unknown }[] = []
    const registeredComponents: unknown[] = []
    const fakeClient = {
      effect: () => undefined,
      locale: { register: () => undefined },
      uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
      modelDirectories: { directoryFor: () => undefined },
      sessions: { binding: () => undefined, list: { getSnapshot: () => ({ current: 'session-root' }), subscribe: () => () => undefined } },
      slots: {
        inject: (_key: string, callback: () => unknown) => { callback() },
        register: (options: { name: string }, component: unknown) => {
          registrations.push(options as never)
          registeredComponents.push(component)
          return () => undefined
        },
      },
    }
    const { apply } = await import('../src/client/index.js')
    apply(fakeClient as never)

    const right = registrations.filter((entry) => entry.name === 'conversation.input.right')
    expect(right).toHaveLength(1)
    expect(right[0]).toMatchObject({ id: 'endeavour-models', order: 1000, locale: NS })
    // Neither old split entry registers any more.
    expect(registrations.some((entry) => entry.id === 'endeavour-challenger-model')).toBe(false)
    expect(registrations.some((entry) => entry.id === 'endeavour-role')).toBe(false)
    expect(registrations.some((entry) => entry.name === 'conversation.input.left')).toBe(false)
    // Speed (10) and limits (20) keep their place ahead of the unified control.
    const ordered = [
      { id: 'openai-codex-fast-mode', order: 10 },
      { id: 'openai-codex-quota', order: 20 },
      { id: 'endeavour-models', order: right[0]?.order ?? 0 },
    ].sort((a, b) => a.order - b.order).map((entry) => entry.id)
    expect(ordered).toEqual(['openai-codex-fast-mode', 'openai-codex-quota', 'endeavour-models'])
    // The injected prop is the two-role bridge, and it resolves without a host.
    const inject = right[0]?.inject as ((sessionId: string) => { unifiedModels: unknown }) | undefined
    expect(typeof inject).toBe('function')
    const injected = inject?.('session-root')
    expect(Object.keys(injected?.unifiedModels as object)).toEqual(['roles'])
  })
})

describe('injected stylesheet', () => {
  const selectors = STYLE_TEXT.split('}').map((block) => block.split('{')[0] ?? '').join('\n')

  it('never targets hashed module classes', () => {
    expect(selectors).not.toMatch(/_[A-Za-z0-9]{5,}/)
    expect(STYLE_TEXT).not.toMatch(/\.IecIca|\.gHIxMG|\.p_[A-Za-z0-9]/)
  })

  it('pins the unified trigger contract', () => {
    const trigger = STYLE_TEXT.match(/\.dsh-endeavour-unified-trigger \{[^}]*\}/)?.[0] ?? ''
    expect(trigger).toContain('height: 28px')
    expect(trigger).toContain('justify-content: center')
    expect(trigger).toContain('color: var(--dsw-alias-label-secondary)')
    expect(trigger).toContain('background: var(--dsw-alias-interactive-bg-hover)')
    expect(trigger).toContain('border-radius: 8px')
    const glyph = STYLE_TEXT.match(/\.dsh-endeavour-role-glyph \{[^}]*\}/)?.[0] ?? ''
    expect(glyph).toContain('color: currentColor')
    expect(glyph).toContain('flex: none')
  })

  it('hides the native model seat only while the unified control is rendered', () => {
    expect(STYLE_TEXT).toContain('[data-composer-card]:has([data-endeavour-unified-models]) [data-slot="conversation.input.model"] { display: none; }')
    // The hide rule is scoped to the control's own card and never unconditional.
    expect(STYLE_TEXT).not.toMatch(/^\s*\[data-slot="conversation\.input\.model"\]\s*\{\s*display: none/m)
    expect(STYLE_TEXT).not.toContain('[data-endeavour-role="endeavour"] [data-slot="conversation.input.model"] { display: none; }')
  })

  it('retires every rule of the removed split controls', () => {
    for (const dead of [
      '.dsh-endeavour-role-label',
      '.dsh-endeavour-endeavour-role',
      '.dsh-endeavour-builder-control',
      '.dsh-endeavour-builder-trigger',
      '.dsh-endeavour-builder-model',
      '.dsh-endeavour-builder-effort',
      '.dsh-endeavour-builder-saving',
      '.dsh-endeavour-builder-chevron',
      '[data-endeavour-role="endeavour"]',
      '[data-endeavour-role="challenger-model"]',
      'max-width: 152px',
    ]) {
      expect(STYLE_TEXT).not.toContain(dead)
    }
    expect(STYLE_TEXT).not.toMatch(/@media \(max-width: 1500px\)|@media \(max-width: 1440px\)/)
  })

  it('styles the two menu sections of the unified control', () => {
    const section = STYLE_TEXT.match(/\.dsh-endeavour-menu-section \{[^}]*\}/)?.[0] ?? ''
    expect(section).toContain('display: flex')
    expect(section).toContain('gap: 6px')
    expect(section).toContain('color: var(--dsw-alias-label-tertiary)')
    const icon = STYLE_TEXT.match(/\.dsh-endeavour-menu-section-icon \{[^}]*\}/)?.[0] ?? ''
    expect(icon).toContain('width: 16px')
    expect(icon).toContain('height: 16px')
    const title = STYLE_TEXT.match(/\.dsh-endeavour-menu-title \{[^}]*\}/)?.[0] ?? ''
    expect(title).toContain('color: var(--dsw-alias-label-tertiary)')
  })

  it('copies the native ModelSelect menu tokens exactly', () => {
    const menu = STYLE_TEXT.match(/\.dsh-endeavour-menu \{[^}]*\}/)?.[0] ?? ''
    expect(menu).toContain('position: fixed')
    expect(menu).toContain('z-index: 1100')
    expect(menu).toContain('width: max-content')
    expect(menu).toContain('min-width: min(240px, calc(100vw - 32px))')
    expect(menu).toContain('max-width: min(420px, calc(100vw - 32px))')
    expect(menu).toContain('max-height: min(360px, calc(100vh - 96px))')
    expect(menu).toContain('padding: 4px')
    expect(menu).toContain('border: 0')
    expect(menu).toContain('border-radius: 20px')
    expect(menu).toContain('background: var(--dsw-specific-menu)')
    expect(menu).toContain('box-shadow: var(--dsw-elevation-prominent)')
    const cell = STYLE_TEXT.match(/\.dsh-endeavour-menu-cell \{[^}]*\}/)?.[0] ?? ''
    expect(cell).toContain('height: 40px')
    expect(cell).toContain('padding: 0 10px')
    const option = STYLE_TEXT.match(/\.dsh-endeavour-menu-option \{[^}]*\}/)?.[0] ?? ''
    expect(option).toContain('min-height: 38px')
    const name = STYLE_TEXT.match(/\.dsh-endeavour-menu-option-name \{[^}]*\}/)?.[0] ?? ''
    expect(name).toContain('font-size: 14px')
    expect(name).toContain('font-weight: 500')
  })

  it('disables native wrapping through stable anchors', () => {
    expect(STYLE_TEXT).toContain('[data-composer-card] [data-input-scroll] + div {')
    expect(STYLE_TEXT).toContain('flex-wrap: nowrap;')
    expect(STYLE_TEXT).toContain('[data-slot="conversation.input.model"] > div {')
  })
})

describe('English copy and planning prompts', () => {
  it('produces English copy for every locale seat and the fallback', () => {
    expect(copyFrom({})('stage.confirmed')).toBe('Confirmed')
    expect(copyFrom({ t: (key: string) => (key === 'plan.openBuilder' ? 'Open Builder' : undefined) })('plan.openBuilder')).toBe('Open Builder')
    expect(formatEnglish('plan.progress', { confirmed: 1, total: 2 })).toBe('1 / 2 confirmed')
    for (const value of Object.values(en)) expect(value).toMatch(/^[\x20-\x7E]*$/)
  })

  it('keeps the unified control copy in the shared namespace', () => {
    expect(en['unified.trigger']).toBe('Model settings: Endeavour and Challenger')
    expect(en['unified.endeavour']).toBe('Endeavour')
    expect(en['unified.challenger']).toBe('Challenger')
    expect(en['builder.model']).toBe('Model')
    expect(en['builder.effort']).toBe('Effort')
    expect(NS).toBe('endeavour')
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
