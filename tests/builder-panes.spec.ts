// @vitest-environment happy-dom
/**
 * Builder route menu pane structure and mouse/keyboard navigation.
 *
 * The menu mirrors upstream ModelSelect: the root pane holds exactly two drill
 * rows (Model, Thinking), so a large catalog can never bury the thinking
 * options; drills push a pane, Back/Escape pops one level, and the selected row
 * receives focus on entry.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { BuilderRouteControl, type BuilderRouteController } from '../src/client/BuilderRouteControl.js'
import type { BuilderRouteSettings } from '../src/builder-settings.js'
import { STYLE_TEXT } from '../src/client/styles.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 40-model catalog: heavy enough that thinking would be buried if flat. */
function bigCatalog(): ModelCatalog {
  const filler = Array.from({ length: 37 }, (_, index) => ({ id: `f${index + 1}`, name: `Filler ${index + 1}` }))
  return {
    default: { provider: 'g1', model: 'f1' },
    routableProviders: ['g1', 'g2'],
    groups: [
      { id: 'g1', name: 'Group One', models: [
        { id: 'ma', name: 'Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
        { id: 'mb', name: 'Model B' },
        ...filler,
      ] },
      { id: 'g2', name: 'Group Two', models: [{ id: 'mc', name: 'Model C', reasoning: { efforts: [{ id: 'x', name: 'Extra' }], defaultEffort: 'x' } }] },
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

function render(settings: BuilderRouteSettings = { mode: 'inherit' }) {
  const writes: BuilderRouteSettings[] = []
  let current = settings
  const controller: BuilderRouteController = {
    readSettings: () => current,
    writeSettings: async (next) => { writes.push(next); current = next },
    loadCatalog: async () => bigCatalog(),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(BuilderRouteControl, {
      useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : null),
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
  return container.querySelector('[role="menu"]') as HTMLElement
}

function paneName(container: HTMLElement): string | null {
  return menu(container)?.getAttribute('data-endeavour-builder-pane') ?? null
}

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')] as HTMLElement[]
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
  return container.querySelector('[class*="menu-row--active"]') as HTMLElement | undefined
}

async function click(element: Element | undefined | null): Promise<void> {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
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

describe('root pane', () => {
  it('shows exactly the two drill rows even with a 40-model catalog', async () => {
    const view = render()
    await open(view.container)
    expect(paneName(view.container)).toBe('root')
    expect(rows(view.container)).toHaveLength(2)
    expect(labels(view.container)[0]).toContain('Model')
    expect(labels(view.container)[0]).toContain('Inherit Planner')
    expect(labels(view.container)[1]).toContain('Thinking')
    expect(labels(view.container)[1]).toContain('Inherited')
    expect(labels(view.container).join(' ')).not.toContain('Filler')
  })

  it('marks Thinking non-drillable in inherit mode and when the model has no reasoning', async () => {
    const inherit = render({ mode: 'inherit' })
    await open(inherit.container)
    expect((rows(inherit.container)[1] as HTMLButtonElement).disabled).toBe(true)
    await click(rows(inherit.container)[1])
    expect(paneName(inherit.container)).toBe('root')

    const plain = render({ mode: 'custom', provider: 'g1', model: 'mb' })
    await open(plain.container)
    expect(labels(plain.container)[1]).toContain('Not available')
    expect((rows(plain.container)[1] as HTMLButtonElement).disabled).toBe(true)
    expect((rows(plain.container)[0] as HTMLButtonElement).textContent).toContain('Model B')
  })
})

describe('model and thinking panes', () => {
  it('keeps model rows in the model pane and effort rows only in the thinking pane', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    expect(paneName(view.container)).toBe('model')
    const modelLabels = labels(view.container)
    expect(modelLabels[0]).toContain('Back')
    expect(modelLabels[1]).toContain('Inherit Planner')
    const headers = [...view.container.querySelectorAll('[class*="menu-header"]')].map((node) => node.textContent)
    expect(headers).toEqual(['Group One', 'Group Two'])
    expect(modelLabels.filter((label) => label.includes('Filler')).length).toBeGreaterThan(30)
    expect(modelLabels.some((label) => label.includes('Provider default'))).toBe(false)

    await click(rowByText(view.container, 'Back'))
    expect(paneName(view.container)).toBe('root')
    expect(labels(view.container)[1]).toContain('Medium')
    await click(rows(view.container)[1])
    expect(paneName(view.container)).toBe('thinking')
    const effortLabels = labels(view.container)
    expect(effortLabels[0]).toContain('Back')
    expect(effortLabels).toEqual(expect.arrayContaining(['✓ Medium', 'Low', 'High']))
    expect(effortLabels.some((label) => label.includes('Filler') || label.includes('Model A'))).toBe(false)
  })

  it('returns to root after a model switch, showing the model default effort', async () => {
    const view = render({ mode: 'inherit' })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    await click(rowByText(view.container, 'Model A'))
    expect(paneName(view.container)).toBe('root')
    expect(chip(view.container).textContent).toContain('Model A')
    expect(chip(view.container).textContent).toContain('medium')
    expect(labels(view.container)[1]).toContain('Medium')
    expect((rows(view.container)[1] as HTMLButtonElement).disabled).toBe(false)
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
  })

  it('persists an explicit effort and Provider default from the thinking pane', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(view.container)
    await click(rows(view.container)[1])
    await click(rowByText(view.container, 'High'))
    expect(paneName(view.container)).toBe('root')
    expect(chip(view.container).textContent).toContain('high')
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'high' })

    await click(rows(view.container)[1])
    await click(rowByText(view.container, 'Provider default'))
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma' })
    expect(labels(view.container)[1]).toContain('Provider default')
  })

  it('selects Inherit from the model pane and returns to root', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'high' })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    await click(rowByText(view.container, 'Inherit Planner'))
    expect(paneName(view.container)).toBe('root')
    expect(chip(view.container).textContent).toContain('Builder · Inherit')
    expect(view.writes.at(-1)).toEqual({ mode: 'inherit' })
  })
})

describe('keyboard and focus', () => {
  it('drills with Enter/Space, wraps arrows, and lands focus on the selected row', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(view.container)
    await key(view.container, 'ArrowUp') // wrap to last root row (Thinking)
    expect(activeRow(view.container)?.textContent).toContain('Thinking')
    await key(view.container, 'ArrowDown') // wrap back to Model
    expect(activeRow(view.container)?.textContent).toContain('Model')
    await key(view.container, 'Enter')
    expect(paneName(view.container)).toBe('model')
    expect(activeRow(view.container)?.textContent).toContain('Model A')

    await key(view.container, 'ArrowDown')
    await key(view.container, 'ArrowUp')
    expect(activeRow(view.container)?.textContent).toContain('Model A')
    await key(view.container, ' ')
    expect(paneName(view.container)).toBe('root')

    await key(view.container, 'ArrowDown')
    expect(activeRow(view.container)?.textContent).toContain('Thinking')
    await key(view.container, 'ArrowDown')
    expect(activeRow(view.container)?.textContent).toContain('Model')
  })

  it('Escape backs out of a drill pane and closes the root, restoring chip focus', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(view.container)
    await click(rowByText(view.container, 'Model'))
    expect(paneName(view.container)).toBe('model')
    await key(view.container, 'Escape')
    expect(paneName(view.container)).toBe('root')
    expect(menu(view.container)).toBeTruthy()
    await key(view.container, 'Escape')
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(chip(view.container))
  })

  it('closes on Tab and returns focus to the chip', async () => {
    const view = render()
    await open(view.container)
    await key(view.container, 'Tab')
    expect(view.container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(chip(view.container))
  })

  it('drills into Thinking without any model rows, choosing an effort with the keyboard', async () => {
    const view = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(view.container)
    await key(view.container, 'ArrowDown')
    await key(view.container, 'Enter')
    expect(paneName(view.container)).toBe('thinking')
    expect(activeRow(view.container)?.textContent).toContain('Medium')
    await key(view.container, 'ArrowDown')
    await key(view.container, 'Enter')
    expect(paneName(view.container)).toBe('root')
    expect(view.writes.at(-1)).toEqual({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'high' })
  })

  it('offers a single effort for a one-effort model and keeps large groups scrollable', async () => {
    const view = render({ mode: 'custom', provider: 'g2', model: 'mc', reasoningEffort: 'x' })
    await open(view.container)
    await click(rows(view.container)[1])
    expect(labels(view.container)).toEqual(['Back', 'Provider default', '✓ Extra'])
    expect(menu(view.container).className).toContain('menu')

    const big = render({ mode: 'custom', provider: 'g1', model: 'ma', reasoningEffort: 'medium' })
    await open(big.container)
    await click(rowByText(big.container, 'Model'))
    expect(menu(big.container).className).toContain('dsh-endeavour-menu')
    const menuCss = STYLE_TEXT.slice(STYLE_TEXT.indexOf('.dsh-endeavour-menu '), STYLE_TEXT.indexOf('.dsh-endeavour-menu-row {'))
    expect(menuCss).toContain('max-height: 320px')
    expect(menuCss).toContain('overflow-y: auto')
    expect(menuCss).toContain('max-width: min(360px, calc(100vw - 24px))')
  })
})
