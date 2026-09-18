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

describe('Builder group', () => {
  it('renders a static Builder segment plus a route-only trigger', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, {
      ...seatProps('endeavour'),
      builderRoute: controller(),
    } as never))
    expect(html).toContain('data-endeavour-role="builder"')
    expect(html).toContain('>Builder</span>')
    expect(html).toContain('class="dsh-endeavour-builder-trigger"')
    expect(html).toContain('>Inherit Endeavour</span>')
    expect(html).not.toMatch(/Builder \u00b7/)
  })
  it('keeps the route value and full accessible name on the trigger', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, {
      ...seatProps('endeavour'),
      builderRoute: controller(),
    } as never))
    expect(html).toContain('aria-label="Builder: Inherit Endeavour"')
    expect(html).toContain('title="Builder: Inherit Endeavour"')
  })
})

describe('slot registration', () => {
  it('registers the left Builder group at order 20 and the right label last at order 1000', async () => {
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
    const left = registrations.find((entry) => entry.name === 'conversation.input.left')
    const right = registrations.find((entry) => entry.name === 'conversation.input.right')
    expect(left).toMatchObject({ id: 'endeavour-builder', order: 20, locale: NS })
    expect(right).toMatchObject({ id: 'endeavour-role', order: 1000, locale: NS })
    // The native model seat renders after the whole right list, so the LAST
    // right-side entry (highest order, after the cost meter at order 5) is the
    // one that lands immediately before it.
    expect(right?.order).toBeGreaterThan(5)
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

  it('pins the 28px segmented surface and the shrink-priority breakpoints', () => {
    const heightRule = STYLE_TEXT.match(/\.dsh-endeavour-builder-control \{[^}]*\}/)?.[0] ?? ''
    expect(heightRule).toContain('height: 28px')
    expect(STYLE_TEXT).toContain('@media (max-width: 1280px)')
    expect(STYLE_TEXT).toContain('span:nth-of-type(2) { display: none; }')
    expect(STYLE_TEXT).toContain('@media (max-width: 1024px)')
    expect(STYLE_TEXT).toContain("@media (max-width: 1024px) {\n  .dsh-endeavour-role-label, .dsh-endeavour-endeavour-role { font-size: 0;")
  })

  it('documents the shrink priority in the source stylesheet', () => {
    const source = readFileSync('src/client/styles.ts', 'utf8')
    expect(source).toMatch(/Shrink priority 1: effort captions/)
    expect(source).toMatch(/Shrink priority 2 \+ 3/)
  })
})
