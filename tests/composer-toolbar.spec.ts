// @vitest-environment happy-dom
/**
 * Composer toolbar composition regressions.
 *
 * The composer carries DSH's own Endeavour model selector plus ONE custom
 * Challenger selector (`endeavour-challenger-model`, order 1000) registered in
 * the trailing-controls list seat, which renders immediately left of that
 * selector. The native control is never replaced, unregistered or hidden. These
 * tests pin the single custom registration beside the native one, the host's
 * real multi-entry seat contract, the icon markup and its accessible name, the
 * injected stylesheet contract, the retired split controls, and the English copy
 * and planning prompts.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { STYLE_TEXT } from '../src/client/styles.js'
import { NS, en, formatEnglish } from '../src/client/locales.js'
import { copyFrom } from '../src/client/PlanCard.js'

describe('slot registration', () => {
  it('activates while the host model seat is occupied, and registers beside it', async () => {
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
    const { apply, CHALLENGER_MODEL_SEAT } = await import('../src/client/index.js')
    apply(fakeClient as never)

    const custom = registrations.filter((entry) => entry.id === 'endeavour-challenger-model')
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({ name: CHALLENGER_MODEL_SEAT, order: 1000, locale: NS })
    // The retired combined control and every older split entry are gone.
    expect(registrations.some((entry) => entry.id === 'endeavour-models')).toBe(false)
    expect(registrations.some((entry) => entry.id === 'endeavour-role')).toBe(false)
    expect(registrations.some((entry) => entry.name === 'conversation.input.left')).toBe(false)
    // The host's own selector keeps the single-occupancy model seat to itself.
    expect(registrations.some((entry) => entry.name === 'conversation.input.model')).toBe(false)
    // Speed (10) and limits (20) keep their place ahead of the custom control.
    const ordered = [
      { id: 'openai-codex-fast-mode', order: 10 },
      { id: 'openai-codex-quota', order: 20 },
      { id: 'endeavour-challenger-model', order: custom[0]?.order ?? 0 },
    ].sort((a, b) => a.order - b.order).map((entry) => entry.id)
    expect(ordered).toEqual(['openai-codex-fast-mode', 'openai-codex-quota', 'endeavour-challenger-model'])
    // The injected prop is the two-role bridge, and it resolves without a host.
    const inject = custom[0]?.inject as ((sessionId: string) => { unifiedModels: unknown }) | undefined
    expect(typeof inject).toBe('function')
    const injected = inject?.('session-root')
    expect(Object.keys(injected?.unifiedModels as object).sort()).toEqual(['admit', 'applyPendingToPeer', 'pendingSelection', 'roles', 'sourceSnapshot', 'subscribeSource'])
  })

  it('survives the host slot registry while DSH occupies the model seat', async () => {
    vi.resetModules()
    // The host's real registry, with the composer seats ui-conversation declares.
    // Registers are addressed by plain seat name here, so the registry is viewed
    // structurally rather than through the host's typed slot map.
    const registry = new SlotCore() as unknown as {
      register(options: { name: string; children?: Record<string, { kind: string; scope: string }> }, component: unknown): void
      specDynamic(key: string): unknown
      entries(key: string): readonly { readonly options: { readonly id?: string } }[]
    }
    registry.register({
      name: 'root',
      children: {
        'conversation.input.right': { kind: 'list', scope: 'session' },
        'conversation.input.model': { kind: 'single', scope: 'session' },
        'conversation.view': { kind: 'list', scope: 'session' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    }, () => null)
    // DSH's own Endeavour selector already holds the single model seat. A second
    // same-priority registration there is rejected, and because the rejection
    // happens while this plugin activates it fails the WHOLE client module.
    registry.register({ name: 'conversation.input.model' }, () => null)

    const slots = {
      inject: (key: string, callback: () => unknown) => {
        if (registry.specDynamic(key) !== undefined) callback()
        return () => undefined
      },
      register: (options: never, component: unknown) => {
        registry.register(options, component)
        return () => undefined
      },
    }
    const fakeClient = {
      effect: () => undefined,
      locale: { register: () => undefined },
      uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
      modelDirectories: { directoryFor: () => undefined },
      sessions: { binding: () => undefined, list: { getSnapshot: () => ({ current: 'session-root' }), subscribe: () => () => undefined } },
      slots,
    }
    const { apply, CHALLENGER_MODEL_SEAT } = await import('../src/client/index.js')
    expect(() => apply(fakeClient as never)).not.toThrow()

    const custom = registry.entries(CHALLENGER_MODEL_SEAT).filter((entry) => entry.options.id === 'endeavour-challenger-model')
    expect(custom).toHaveLength(1)
    // The native selector still owns the model seat, untouched and unreplaced.
    expect(registry.entries('conversation.input.model')).toHaveLength(1)
  })
})

describe('injected stylesheet', () => {
  const selectors = STYLE_TEXT.split('}').map((block) => block.split('{')[0] ?? '').join('\n')

  it('never targets hashed module classes', () => {
    expect(selectors).not.toMatch(/_[A-Za-z0-9]{5,}/)
    expect(STYLE_TEXT).not.toMatch(/\.IecIca|\.gHIxMG|\.p_[A-Za-z0-9]/)
  })

  it('matches the installed native trigger geometry, type and states token for token', () => {
    const trigger = STYLE_TEXT.match(/\.dsh-endeavour-challenger-trigger \{[^}]*\}/)?.[0] ?? ''
    // height 28, 13/20 regular, 4px gap, 0 4px 0 8px padding, --dsw-radius-sm.
    expect(trigger).toContain('height: 28px')
    expect(trigger).toContain('gap: 4px')
    expect(trigger).toContain('padding: 0 4px 0 8px')
    expect(trigger).toContain('border-radius: var(--dsw-radius-sm)')
    expect(trigger).toContain('font-size: 13px')
    expect(trigger).toContain('font-weight: 400')
    expect(trigger).toContain('line-height: 20px')
    expect(trigger).toContain('background: transparent')
    expect(trigger).toContain('color: var(--dsw-alias-label-secondary)')
    expect(trigger).toContain('max-width: min(360px, 45cqw)')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-challenger-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-challenger-trigger:focus-visible {')
    expect(STYLE_TEXT).toContain('box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-challenger-trigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }')
    // Text ellipsis on the label, caption color on the effort and the chevron,
    // and a chevron that rotates while the popup is open.
    const label = STYLE_TEXT.match(/\.dsh-endeavour-challenger-trigger-label \{[^}]*\}/)?.[0] ?? ''
    expect(label).toContain('text-overflow: ellipsis')
    expect(label).toContain('white-space: nowrap')
    // The compact trigger renders no effort span at all: the visible label is
    // only the role word, and the details live in the tooltip/accessible name.
    expect(STYLE_TEXT).not.toContain('.dsh-endeavour-challenger-trigger-effort')
    const chevron = STYLE_TEXT.match(/\.dsh-endeavour-challenger-chevron \{[^}]*\}/)?.[0] ?? ''
    expect(chevron).toContain('color: var(--dsw-alias-label-caption)')
    expect(chevron).toContain('transition: transform 0.12s')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-challenger-chevron--open { transform: rotate(180deg); }')
    const glyph = STYLE_TEXT.match(/\.dsh-endeavour-role-glyph \{[^}]*\}/)?.[0] ?? ''
    expect(glyph).toContain('color: currentColor')
    expect(glyph).toContain('flex: none')
  })

  it('never hides or restyles the native model seat, and leaves toolbar layout to the host', () => {
    // No rule targets the native seat, its buttons or its internals.
    expect(STYLE_TEXT).not.toContain('display: none')
    expect(STYLE_TEXT).not.toContain('data-endeavour-unified-models')
    expect(STYLE_TEXT).not.toContain('data-input-scroll')
    expect(STYLE_TEXT).not.toContain('[data-slot="conversation.input.right"]')
    expect(STYLE_TEXT).not.toMatch(/\[data-slot="conversation\.input\.model"\]\s*(>|\{)/)
    // The only slot-scoped rules that remain concern the untracked left-side
    // text overflow, never the model seat or the toolbar order.
    expect(STYLE_TEXT).not.toContain('flex-wrap: nowrap')
    expect(STYLE_TEXT).not.toMatch(/^\s*order:\s*0;/m)
    expect(STYLE_TEXT).not.toMatch(/^\s*flex-shrink:\s*1;/m)
  })

  it('retires every rule of the removed split and combined controls', () => {
    for (const dead of [
      '.dsh-endeavour-role-label',
      '.dsh-endeavour-endeavour-role',
      '.dsh-endeavour-builder-control',
      '.dsh-endeavour-builder-trigger',
      '.dsh-endeavour-builder-model',
      '.dsh-endeavour-builder-effort',
      '.dsh-endeavour-builder-saving',
      '.dsh-endeavour-builder-chevron',
      '.dsh-endeavour-unified-control',
      '.dsh-endeavour-unified-trigger',
      '.dsh-endeavour-menu-section',
      '.dsh-endeavour-menu-title',
      '[data-endeavour-role="endeavour"]',
      '[data-endeavour-role="challenger-model"]',
      'max-width: 152px',
    ]) {
      expect(STYLE_TEXT).not.toContain(dead)
    }
    expect(STYLE_TEXT).not.toMatch(/@media \(max-width: 1500px\)|@media \(max-width: 1440px\)/)
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
    expect(menu).toContain('border-radius: var(--dsw-radius-lg)')
    expect(menu).toContain('box-shadow: var(--dsw-elevation-prominent)')
    expect(menu).toContain('--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)')
    expect(menu).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)')
    // The fill and the blur live on an isolated, noninteractive material layer,
    // so backdrop-filter never filters the rows.
    const material = STYLE_TEXT.match(/\.dsh-endeavour-menu-material \{[^}]*\}/)?.[0] ?? ''
    expect(material).toContain('position: absolute')
    expect(material).toContain('inset: 0')
    expect(material).toContain('border-radius: inherit')
    expect(material).toContain('background: var(--dsw-menu-surface-fill, var(--dsw-specific-menu))')
    expect(material).toContain('backdrop-filter: var(--dsw-menu-backdrop-filter)')
    expect(material).toContain('pointer-events: none')
    expect(material).toContain('z-index: -1')
    expect(menu).toContain('isolation: isolate')
    expect(menu).toContain('background: transparent')
    const cell = STYLE_TEXT.match(/\.dsh-endeavour-menu-cell \{[^}]*\}/)?.[0] ?? ''
    expect(cell).toContain('height: 34px')
    expect(cell).toContain('padding: 0 8px')
    expect(cell).toContain('border-radius: var(--dsw-radius-md)')
    expect(cell).toContain('font-size: 13px')
    expect(cell).toContain('line-height: 20px')
    const value = STYLE_TEXT.match(/\.dsh-endeavour-menu-cell-value \{[^}]*\}/)?.[0] ?? ''
    expect(value).toContain('text-align: right')
    expect(value).toContain('text-overflow: ellipsis')
    expect(value).toContain('color: var(--dsw-alias-label-tertiary)')
    const option = STYLE_TEXT.match(/\.dsh-endeavour-menu-option \{[^}]*\}/)?.[0] ?? ''
    expect(option).toContain('min-height: 34px')
    expect(option).toContain('padding: 5px 7px')
    const name = STYLE_TEXT.match(/\.dsh-endeavour-menu-option-name \{[^}]*\}/)?.[0] ?? ''
    expect(name).toContain('font-size: 13px')
    expect(name).toContain('line-height: 18px')
    expect(name).toContain('font-weight: 400')
    expect(name).toContain('text-overflow: ellipsis')
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
