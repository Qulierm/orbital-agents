/** Client Builder route model regressions. */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BuilderRouteControl, type BuilderRouteControlProps, type BuilderRouteController } from '../src/client/BuilderRouteControl.js'
import {
  builderControlDisabled,
  builderControlVisible,
  effectiveEffortId,
  effectiveSelection,
  effortLabelFor,
  findCatalogModel,
  modelHasThinking,
  modelLabelFor,
  resetEffortForModel,
  thinkingOptions,
  type BuilderRouteVisibility,
} from '../src/client/builder-route-model.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

const catalog: ModelCatalog = {
  default: { provider: 'p1', model: 'm1' },
  routableProviders: ['p1', 'p2'],
  groups: [
    { id: 'p1', name: 'Provider One', models: [
      { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      { id: 'm2', name: 'Model Two' },
    ] },
    { id: 'p2', name: 'Provider Two', models: [{ id: 'm3', name: 'Model Three' }] },
  ],
  failures: [],
}

function visibility(overrides: Partial<BuilderRouteVisibility> = {}): BuilderRouteVisibility {
  return { agentPreset: 'endeavour', isSubagent: false, planActive: false, running: false, ...overrides }
}

describe('builder control visibility', () => {
  it('renders only in an Endeavour root session', () => {
    expect(builderControlVisible(visibility())).toBe(true)
    expect(builderControlVisible(visibility({ agentPreset: 'standard' }))).toBe(false)
    expect(builderControlVisible(visibility({ agentPreset: undefined }))).toBe(false)
    expect(builderControlVisible(visibility({ isSubagent: true }))).toBe(false)
  })

  it('disables while a plan is active or the turn runs, with an English reason', () => {
    expect(builderControlDisabled(visibility())).toBeUndefined()
    expect(builderControlDisabled(visibility({ planActive: true }))).toMatch(/fixed while a plan is active/)
    expect(builderControlDisabled(visibility({ running: true }))).toMatch(/Finish the current turn/)
    expect(builderControlDisabled(visibility({ agentPreset: 'standard' }))).toMatch(/only available in Endeavour chats/)
  })

  it('resolves the effective inherited selection and effort labels', () => {
    const selection = effectiveSelection({ next: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } }, catalog)
    expect(selection).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'high' })
    expect(effectiveSelection(undefined, catalog)).toEqual({ provider: 'p1', model: 'm1' })
    expect(effectiveSelection({ next: undefined }, undefined)).toBeUndefined()
    expect(modelLabelFor({ provider: 'p1', model: 'm1' }, findCatalogModel(catalog, 'p1', 'm1'))).toBe('Model One')
    expect(modelLabelFor({ provider: 'p1', model: 'raw-id' }, undefined)).toBe('raw-id')
    expect(effortLabelFor(findCatalogModel(catalog, 'p1', 'm1'), undefined)).toBe('Low')
    expect(effortLabelFor(findCatalogModel(catalog, 'p1', 'm2'), 'low')).toBeUndefined()
    expect(effectiveEffortId(findCatalogModel(catalog, 'p1', 'm1'), undefined)).toBe('low')
  })
})

describe('catalog-driven thinking', () => {
  it('lists the provider default plus adapter-owned efforts, and none without metadata', () => {
    const model = findCatalogModel(catalog, 'p1', 'm1')
    const options = thinkingOptions(model, 'low')
    expect(options.map((option) => option.label)).toEqual(['Provider default', 'Low', 'High'])
    expect(options.map((option) => option.selected)).toEqual([false, true, false])
    expect(thinkingOptions(findCatalogModel(catalog, 'p1', 'm2'), undefined)).toEqual([])
    expect(modelHasThinking(findCatalogModel(catalog, 'p1', 'm2'))).toBe(false)
  })

  it('resets to the model default on switch and never keeps a stale effort', () => {
    expect(resetEffortForModel(findCatalogModel(catalog, 'p1', 'm1'))).toBe('low')
    expect(resetEffortForModel(findCatalogModel(catalog, 'p1', 'm2'))).toBeUndefined()
    expect(resetEffortForModel(findCatalogModel(catalog, 'p2', 'm3'))).toBeUndefined()
  })
})

describe('control rendering', () => {
  function props(overrides: {
    preset?: string | undefined
    subagent?: unknown
    plan?: unknown
    settings?: { mode: 'inherit' | 'custom'; provider?: string; model?: string; reasoningEffort?: string }
  }): BuilderRouteControlProps {
    const controller: BuilderRouteController = {
      readSettings: () => (overrides.settings ?? { mode: 'inherit' }),
      writeSettings: async () => undefined,
      loadCatalog: async () => catalog,
    }
    return {
      useProjection: (key: string) => (key === 'agentPreset' ? overrides.preset : overrides.plan),
      useSession: (selector: (state: unknown) => unknown) => selector({ subagent: overrides.subagent, running: false }),
      builderRoute: controller,
      t: undefined,
    } as never
  }

  it('renders the ring in an Endeavour root session and nothing in Standard/child', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, props({ preset: 'endeavour', plan: null })))
    expect(html).toContain('>Builder</span>')
    expect(html).toContain('data-endeavour-builder=')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toMatch(/Inherit Endeavour|Inherit Planner|>Inherited</)
    expect(renderToStaticMarkup(createElement(BuilderRouteControl, props({ preset: 'standard', plan: null })))).toBe('')
    expect(renderToStaticMarkup(createElement(BuilderRouteControl, props({ preset: 'endeavour', subagent: { mode: 'continuable' } })))).toBe('')
  })

  it('disables the chip while a plan is active', () => {
    const html = renderToStaticMarkup(createElement(BuilderRouteControl, props({ preset: 'endeavour', plan: { planId: 'p1' } })))
    expect(html).toContain('disabled')
    expect(html).toContain('fixed while a plan is active')
  })
})
