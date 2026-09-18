// @vitest-environment happy-dom
/**
 * Builder route control: effective inherited presentation, native-parity
 * Model/Effort panes, and portal placement/navigation regressions.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { BuilderRouteControl, type BuilderRouteController } from '../src/client/BuilderRouteControl.js'
import type { BuilderRouteSettings } from '../src/builder-settings.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function bigCatalog(): ModelCatalog {
  const filler = Array.from({ length: 37 }, (_, index) => ({ id: `f${index + 1}`, name: `Filler ${index + 1}` }))
  return {
    default: { provider: 'g1', model: 'ma' },
    routableProviders: ['g1', 'g2'],
    groups: [
      { id: 'g1', name: 'Group One', models: [
        { id: 'ma', name: 'Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
        { id: 'mb', name: 'Model B' },
        ...filler,
      ] },
      { id: 'g2', name: 'Group Two', models: [{ id: 'mc', name: 'Model C', reasoning: { efforts: [{ id: 'x', name: 'Extra' }] } }] },
    ],
    failures: [],
  }
}

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

interface Options {
  readonly settings?: BuilderRouteSettings
  readonly next?: { provider: string; model: string; reasoningEffort?: string } | undefined
}

function render(options: Options = {}) {
  const writes: BuilderRouteSettings[] = []
  let current = options.settings ?? { mode: 'inherit' }
  const controller: BuilderRouteController = {
    readSettings: () => current,
    writeSettings: async (next) => { writes.push(next); current = next },
    loadCatalog: async () => bigCatalog(),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const projection = options.next === undefined ? undefined : { next: options.next }
  act(() => {
    root.render(createElement(BuilderRouteControl, {
      useProjection: (key: string) => {
        if (key === 'agentPreset') return 'endeavour'
        if (key === 'modelSelection') return projection
        return null
      },
      useSession: (selector: (state: unknown) => unknown) => selector({ running: false }),
      builderRoute: controller,
      t: undefined,
    } as never))
  })
  roots.push(root)
  containers.push(container)
  return { container, writes, current: () => current }
}

function chip(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-endeavour-builder]') as HTMLButtonElement
}

function menu(container: HTMLElement): HTMLElement {
  void container
  return document.body.querySelector('[role="menu"]') as HTMLElement
}

function paneName(container: HTMLElement): string | null {
  return menu(container)?.getAttribute('data-endeavour-builder-pane') ?? null
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...menu(container).querySelectorAll('[role="menuitem"], [role="menuitemradio"]')] as HTMLElement[]
}

function labels(container: HTMLElement): string[] {
  return rows(container).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim())
}

function rowByText(container: HTMLElement, text: string): HTMLElement {
  const match = rows(container).find((row) => (row.textContent ?? '').includes(text))
  if (match === undefined) throw new Error(`row not found: ${text} in ${JSON.stringify(labels(container))}`)
  return match
}

function activeRow(container: HTMLElement): HTMLElement | undefined {
  return menu(container).querySelector('[class*="menu-option--active"], [class*="menu-cell--active"]') as HTMLElement | undefined
}

async function click(element: Element | undefined | null): Promise<void> {
  await act(async () => { element?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function open(container: HTMLElement): Promise<void> {
  await click(chip(container))
  await act(async () => { await Promise.resolve() })
}

async function key(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    menu(container)?.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
  })
}

describe('effective inherited presentation', () => {
  it('shows the actual projected model and effort, never an inheritance word', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma', reasoningEffort: 'high' } })
    await open(view.container)
    expect(paneName(view.container)).toBe('root')
    expect(labels(view.container)).toEqual(['ModelModel A', 'EffortHigh'])
    expect(chip(view.container).textContent).toContain('Model A')
    expect(chip(view.container).textContent).toContain('High')
    expect(document.body.textContent).not.toMatch(/Inherit Endeavour|Inherit Planner|Inherited/)
  })

  it('falls back to the catalog default and resolves the declared default effort', async () => {
    const view = render({ next: undefined })
    await open(view.container)
    expect(labels(view.container)).toEqual(['ModelModel A', 'EffortMedium'])
  })

  it('reacts to a pending projection change without flickering an inheritance word', async () => {
    const view = render({ next: { provider: 'g2', model: 'mc', reasoningEffort: 'x' } })
    await open(view.container)
    expect(labels(view.container)).toEqual(['ModelModel C', 'EffortExtra'])
    expect(document.body.textContent).not.toMatch(/Inherit Endeavour|Inherited/)
  })

  it('disables the Effort cell with Not available when the model has no reasoning', async () => {
    const view = render({ next: { provider: 'g1', model: 'mb' } })
    await open(view.container)
    expect(labels(view.container)[1]).toContain('Not available')
    expect((rows(view.container)[1] as HTMLButtonElement).disabled).toBe(true)
    await click(rows(view.container)[1])
    expect(paneName(view.container)).toBe('root')
  })
})

describe('Model pane', () => {
  it('offers only a label-only Automatic and native group rows (no Back, no descriptions)', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma', reasoningEffort: 'high' } })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    expect(paneName(view.container)).toBe('model')
    const texts = labels(view.container)
    expect(texts[0]).toBe('Automatic')
    expect(texts[0]).not.toContain('Follows')
    expect((rows(view.container)[0] as HTMLElement).getAttribute('title')).toContain('Follows the current Endeavour model and effort.')
    expect((rows(view.container)[0] as HTMLElement).getAttribute('aria-checked')).toBe('true')
    expect(texts.some((label) => /Back|Follows|description|·/.test(label))).toBe(false)
    expect(texts.some((label) => /Inherit/.test(label))).toBe(false)
    expect(menu(view.container).querySelectorAll('[class*="menu-group"]').length).toBe(2)
    expect(texts.filter((label) => label.includes('Filler')).length).toBeGreaterThan(30)
    // Every option is a native 38px row with a trailing check slot.
    expect(rows(view.container).every((row) => row.querySelector('[class*="menu-check"]') !== null)).toBe(true)
  })

  it('closes on a successful model selection and shows its default effort when reopened', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    await click(rowByText(view.container, 'Model C'))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g2', model: 'mc' })
    expect(chip(view.container).textContent).toContain('Model C')
    await open(view.container)
    expect(labels(view.container)).toEqual(['ModelModel C', 'EffortDefault'])
    await click(rows(view.container)[1])
    expect(rowByText(view.container, 'Default').getAttribute('aria-checked')).toBe('true')
    expect(rowByText(view.container, 'Extra').getAttribute('aria-checked')).toBe('false')
    expect(labels(view.container).some((label) => /Back/.test(label))).toBe(false)
  })

  it('returns to following Endeavour through Automatic and closes', async () => {
    const view = render({ settings: { mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'low' } })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    await click(rowByText(view.container, 'Automatic'))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(view.writes.at(-1)).toEqual({ mode: 'inherit' })
  })

  it('keeps the menu open with the error surfaced when the write fails', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const failing: BuilderRouteController = {
      readSettings: () => ({ mode: 'inherit' }),
      writeSettings: async () => { throw new Error('nope') },
      loadCatalog: async () => bigCatalog(),
    }
    act(() => {
      root.render(createElement(BuilderRouteControl, {
        useProjection: (key: string) => {
          if (key === 'agentPreset') return 'endeavour'
          if (key === 'modelSelection') return { next: { provider: 'g1', model: 'ma' } }
          return null
        },
        useSession: (selector: (state: unknown) => unknown) => selector({ running: false }),
        builderRoute: failing,
        t: undefined,
      } as never))
    })
    roots.push(root); containers.push(container)
    await open(container)
    await click(rowByText(container, 'Model'))
    await click(rowByText(container, 'Automatic'))
    expect(paneName(container)).toBe('model')
    expect(menu(container).textContent).toContain('Could not save the Builder route')
  })
})

describe('Effort pane', () => {
  it('pins an effort from the inherited route and closes the menu', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    await open(view.container)
    expect(labels(view.container)[1]).toContain('Medium')
    await click(rows(view.container)[1])
    expect(paneName(view.container)).toBe('effort')
    const texts = labels(view.container)
    expect(texts).toEqual(['Default', 'Low', 'Medium', 'High'])
    expect(texts.some((label) => /Back/.test(label))).toBe(false)
    expect(rowByText(view.container, 'Medium').getAttribute('aria-checked')).toBe('true')
    await click(rowByText(view.container, 'High'))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'high' })
    expect(chip(view.container).textContent).toContain('High')
  })

  it('can select the provider default explicitly', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma', reasoningEffort: 'high' } })
    await open(view.container)
    await click(rows(view.container)[1])
    await click(rowByText(view.container, 'Default'))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma' })
  })
})

describe('portal, placement, and keyboard', () => {
  it('portals the card to body and places it fixed from the trigger rect', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    const trigger = chip(view.container)
    trigger.getBoundingClientRect = () => ({ right: 500, top: 300, bottom: 328, left: 340, width: 160, height: 28, x: 340, y: 300, toJSON: () => ({}) }) as DOMRect
    await open(view.container)
    const card = menu(view.container)
    expect(card.parentElement).toBe(document.body)
    expect(card.style.position).toBe('fixed')
    expect(card.style.left).toBe('500px')
    expect(card.style.top).toBe('292px')
  })

  it('re-places on scroll and closes on outside pointer down', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    const trigger = chip(view.container)
    let top = 300
    trigger.getBoundingClientRect = () => ({ right: 500, top, bottom: top + 28, left: 340, width: 160, height: 28, x: 340, y: top, toJSON: () => ({}) }) as DOMRect
    await open(view.container)
    expect(menu(view.container).style.top).toBe('292px')
    top = 200
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    expect(menu(view.container).style.top).toBe('192px')
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it('drills with Enter/Space, wraps arrows, backs out with Escape, and closes on Tab', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    await open(view.container)
    await key(view.container, 'ArrowDown')
    expect(activeRow(view.container)?.textContent).toContain('Effort')
    await key(view.container, 'ArrowDown') // wrap to Model
    expect(activeRow(view.container)?.textContent).toContain('Model')
    await key(view.container, 'Enter')
    expect(paneName(view.container)).toBe('model')
    expect(activeRow(view.container)?.textContent).toContain('Automatic')
    await key(view.container, 'Escape')
    expect(paneName(view.container)).toBe('root')
    await key(view.container, 'ArrowDown')
    await key(view.container, 'ArrowDown') // wrap back to Model
    await key(view.container, 'Enter')
    expect(paneName(view.container)).toBe('model')
    await key(view.container, 'Escape')
    expect(paneName(view.container)).toBe('root')
    await key(view.container, 'Tab')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(chip(view.container))
  })

  it('keeps a 40-model catalog from burying the effort cell', async () => {
    const view = render({ next: { provider: 'g1', model: 'ma' } })
    await open(view.container)
    expect(rows(view.container)).toHaveLength(2)
    await click(rows(view.container)[1])
    expect(paneName(view.container)).toBe('effort')
    expect(rows(view.container).some((row) => (row.textContent ?? '').includes('Filler'))).toBe(false)
  })
})
