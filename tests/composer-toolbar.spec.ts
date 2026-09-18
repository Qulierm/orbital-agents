// @vitest-environment happy-dom
/**
 * Composer toolbar composition regressions.
 *
 * The redesigned toolbar is one row: a left `[Builder | route]` group and a
 * right `[Endeavour]` label joined to the untouched native ModelSelect trigger.
 * These tests pin the group structure, the visibility matrix, the slot
 * registration order that places the label immediately before the native
 * `conversation.input.model` seat, and the absence of hashed selectors in the
 * injected CSS.
 */

import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BuilderRouteControl, type BuilderRouteController } from '../src/client/BuilderRouteControl.js'
import { EndeavourRoleLabel } from '../src/client/EndeavourRoleLabel.js'
import { STYLE_TEXT } from '../src/client/styles.js'
import { NS } from '../src/client/locales.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

const catalog: ModelCatalog = {
  default: { provider: 'p1', model: 'm1' },
  routableProviders: ['p1'],
  groups: [{ id: 'p1', name: 'Provider One', models: [
    { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
  ] }],
  failures: [],
}

function controller(): BuilderRouteController {
  return {
    readSettings: () => ({ mode: 'inherit' }),
    writeSettings: async () => undefined,
    loadCatalog: async () => catalog,
  }
}

function seatProps(preset: string | undefined, subagent: unknown = null): Record<string, unknown> {
  return {
    useProjection: (key: string) => (key === 'agentPreset' ? preset : null),
    useSession: (selector: (state: unknown) => unknown) => selector({ subagent, running: false }),
    t: undefined,
  }
}

describe('Endeavour role label', () => {
  it('renders only in an Endeavour root session', () => {
    const html = renderToStaticMarkup(createElement(EndeavourRoleLabel, seatProps('endeavour') as never))
    expect(html).toContain('data-endeavour-role="endeavour"')
    expect(html).toContain('>Endeavour</span>')
    expect(renderToStaticMarkup(createElement(EndeavourRoleLabel, seatProps('standard') as never))).toBe('')
    expect(renderToStaticMarkup(createElement(EndeavourRoleLabel, seatProps(undefined) as never))).toBe('')
    expect(renderToStaticMarkup(createElement(EndeavourRoleLabel, seatProps('endeavour', { mode: 'continuable' }) as never))).toBe('')
  })

  it('is a static, non-interactive label that never wraps the native selector', () => {
    const html = renderToStaticMarkup(createElement(EndeavourRoleLabel, seatProps('endeavour') as never))
    expect(html).not.toContain('<button')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('title="Endeavour model (this session)"')
  })
})

describe('Challenger group', () => {
  it('renders a static Builder segment plus a route-only trigger', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, {
      ...seatProps('endeavour'),
      builderRoute: controller(),
    } as never))
    expect(html).toContain('data-endeavour-role="builder"')
    expect(html).toContain('>Challenger</span>')
    expect(html).toContain('class="dsh-endeavour-builder-trigger"')
    expect(html).not.toMatch(/Inherit Endeavour|Inherit Planner|>Inherited</)
  })
  it('keeps the route value and full accessible name on the trigger', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, {
      ...seatProps('endeavour'),
      builderRoute: controller(),
    } as never))
    expect(html).toContain('aria-label="Builder model"')
    expect(html).toContain('title="Builder model"')
  })
})

describe('slot registration', () => {
  it('keeps both role groups adjacent at the end of the right slot, before the native model seat', async () => {
    vi.resetModules()
    const registrations: { name: string; id?: string; order?: number; locale?: string }[] = []
    const registeredComponents: unknown[] = []
    const fakeClient = {
      effect: () => undefined,
      locale: { register: () => undefined },
      uiConversation: { events: { register: () => undefined } },
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
    const builder = registrations.find((entry) => entry.id === 'endeavour-builder')
    const role = registrations.find((entry) => entry.id === 'endeavour-role')
    expect(registrations.some((entry) => entry.name === 'conversation.input.left')).toBe(false)
    expect(builder).toMatchObject({ name: 'conversation.input.right', order: 1000, locale: NS })
    expect(role).toMatchObject({ name: 'conversation.input.right', order: 1001, locale: NS })
    // Sequence contract: native Speed (10) and limits (20) stay ahead, then the
    // adjacent Builder (1000) and Endeavour (1001) groups; the native
    // conversation.input.model seat renders after the whole right list.
    const ordered = [
      { id: 'openai-codex-fast-mode', order: 10 },
      { id: 'openai-codex-quota', order: 20 },
      { id: 'endeavour-builder', order: builder?.order ?? 0 },
      { id: 'endeavour-role', order: role?.order ?? 0 },
    ].sort((a, b) => a.order - b.order).map((entry) => entry.id)
    expect(ordered).toEqual(['openai-codex-fast-mode', 'openai-codex-quota', 'endeavour-builder', 'endeavour-role'])
    expect((role?.order ?? 0) - (builder?.order ?? 0)).toBe(1)
  })
})

describe('injected stylesheet', () => {
  const selectors = STYLE_TEXT.split('}').map((block) => block.split('{')[0] ?? '').join('\n')
  it('never targets hashed module classes', () => {
    expect(selectors).not.toMatch(/_[A-Za-z0-9]{5,}/)
    expect(STYLE_TEXT).not.toMatch(/\.IecIca|\.gHIxMG|\.p_[A-Za-z0-9]/)
  })

  it('scopes the joined right group through stable data attributes', () => {
    expect(STYLE_TEXT).toContain('[data-composer-card]:has([data-endeavour-role="endeavour"]) [data-slot="conversation.input.model"] button')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-endeavour-role')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-role-label')
  })

  it('pins the native trigger contract and the shrink-priority breakpoints', () => {
    const control = STYLE_TEXT.match(/\.dsh-endeavour-builder-control \{[^}]*\}/)?.[0] ?? ''
    expect(control).toContain('height: 28px')
    const trigger = STYLE_TEXT.match(/\.dsh-endeavour-builder-trigger \{[^}]*\}/)?.[0] ?? ''
    expect(trigger).toContain('height: 28px')
    expect(trigger).toContain('font-size: 13px')
    expect(trigger).toContain('line-height: 20px')
    expect(trigger).toContain('font-weight: 500')
    expect(trigger).toContain('color: var(--dsw-alias-label-secondary)')
    expect(trigger).toContain('border-radius: 0 8px 8px 0')
    const effort = STYLE_TEXT.match(/\.dsh-endeavour-builder-effort \{[^}]*\}/)?.[0] ?? ''
    expect(effort).toContain('color: var(--dsw-alias-label-caption)')
    expect(STYLE_TEXT).toContain('@media (max-width: 1500px)')
    expect(STYLE_TEXT).toContain('.dsh-endeavour-builder-effort { display: none; }')
    expect(STYLE_TEXT).toContain('@media (max-width: 1440px)')
    expect(STYLE_TEXT).toContain('span:nth-of-type(2) { display: none; }')
    expect(STYLE_TEXT).toContain('@media (max-width: 1360px)')
    expect(STYLE_TEXT).toContain('font-size: 13px; line-height: 20px; font-weight: 500;')
    expect(STYLE_TEXT).toContain('@media (max-width: 1024px)')
    expect(STYLE_TEXT).toContain('max-width: 120px')
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
    expect(menu).toContain('--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)')
    expect(menu).toContain('box-shadow: var(--dsw-elevation-prominent)')
    expect(menu).toContain('--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)')
    const cell = STYLE_TEXT.match(/\.dsh-endeavour-menu-cell \{[^}]*\}/)?.[0] ?? ''
    expect(cell).toContain('height: 40px')
    expect(cell).toContain('padding: 0 10px')
    expect(cell).toContain('border-radius: 10px')
    expect(cell).toContain('font-size: 14px')
    expect(cell).toContain('line-height: 22px')
    const value = STYLE_TEXT.match(/\.dsh-endeavour-menu-cell-value \{[^}]*\}/)?.[0] ?? ''
    expect(value).toContain('color: var(--dsw-alias-label-tertiary)')
    const option = STYLE_TEXT.match(/\.dsh-endeavour-menu-option \{[^}]*\}/)?.[0] ?? ''
    expect(option).toContain('min-height: 38px')
    expect(option).toContain('border-radius: 10px')
    const name = STYLE_TEXT.match(/\.dsh-endeavour-menu-option-name \{[^}]*\}/)?.[0] ?? ''
    expect(name).toContain('font-size: 14px')
    expect(name).toContain('line-height: 20px')
    expect(name).toContain('font-weight: 500')
  })

  it('portals the menu and places it from the trigger rect with scroll/resize tracking', () => {
    const source = readFileSync('src/client/BuilderRouteControl.tsx', 'utf8')
    expect(source).toContain("createPortal(")
    expect(source).toContain('document.body')
    expect(source).toContain('getBoundingClientRect()')
    expect(source).toContain("window.addEventListener('scroll', place, true)")
    expect(source).toContain("window.addEventListener('resize', place)")
    expect(source).toContain('visibility: \'hidden\'')
    expect(source).toContain("'builder.model'")
    expect(source).toContain("'builder.effort'")
    expect(source).toContain("'builder.automatic'")
    expect(source).not.toMatch(/Inherit Endeavour|Inherit Planner/)
  })

  it('disables native wrapping through stable anchors and shrinks only designated items', () => {
    expect(STYLE_TEXT).toContain('[data-composer-card] [data-input-scroll] + div {')
    expect(STYLE_TEXT).toContain('flex-wrap: nowrap;')
    expect(STYLE_TEXT).toContain('[data-slot="conversation.input.model"] > div {')
  })

  it('documents the shrink priority in the source stylesheet', () => {
    const source = readFileSync('src/client/styles.ts', 'utf8')
    expect(source).toMatch(/Shrink priority 1: effort captions/)
    expect(source).toMatch(/Shrink priority 2: long model names/)
    expect(source).toMatch(/Shrink priority 3: role labels/)
  })
})
