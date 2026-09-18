// @vitest-environment happy-dom
/**
 * Unified Endeavour + Challenger model control: one registration, one icon-only
 * trigger, one menu with a section per role, role-targeted directory reads,
 * subscriptions, catalog loads and writes, independent model/thinking state,
 * model-default effort reset, local error reporting and keyboard behaviour.
 */

import { readFileSync } from 'node:fs'
import { Component, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UNIFIED_ROLES,
  UnifiedModelControl,
  type UnifiedModelController,
  type UnifiedRole,
  type UnifiedRoleController,
  type UnifiedSelection,
} from '../src/client/UnifiedModelControl.js'
import { challengerSessionIdFor, peerPairIdFor, type PeerState } from '../src/peer.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

const catalog: ModelCatalog = {
  default: { provider: 'p1', model: 'm1' },
  routableProviders: ['p1', 'p2'],
  groups: [
    { id: 'p1', name: 'Provider One', models: [
      { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      { id: 'm2', name: 'Model Two' },
    ] },
  ],
  failures: [],
}

function pair(rootId = 'session-root'): PeerState {
  return {
    version: 1,
    pairId: peerPairIdFor(rootId),
    endeavourSessionId: rootId,
    challengerSessionId: challengerSessionIdFor(rootId),
    createdAt: 1,
    updatedAt: 1,
    sequence: 1,
  }
}

interface RoleSpy {
  readonly calls: { provider: string; model: string; effort: string | undefined }[]
  readonly listeners: Set<() => void>
  selections: UnifiedSelection | undefined
  loads: number
}

interface Harness {
  readonly controller: UnifiedModelController
  readonly spies: Record<UnifiedRole, RoleSpy>
  fail(role: UnifiedRole): void
  failLoad(role: UnifiedRole): void
  succeedLoad(role: UnifiedRole): void
  setSelection(role: UnifiedRole, selection: UnifiedSelection | undefined): void
  /** The paired Challenger directory starts throwing, like the real resolver. */
  breakChallenger(): void
  /** It resolves again. */
  repairChallenger(): void
}

/**
 * Two independent role bridges. Each spy records its own calls and loads, so a
 * cross-role write or a shared selection store is detectable.
 */
function harness(options: {
  endeavour?: UnifiedSelection | undefined
  challenger?: UnifiedSelection | undefined
  absent?: readonly UnifiedRole[]
} = {}): Harness {
  const spies: Record<UnifiedRole, RoleSpy> = {
    endeavour: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0 },
    challenger: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0 },
  }
  if ('endeavour' in options) spies.endeavour.selections = options.endeavour
  if ('challenger' in options) spies.challenger.selections = options.challenger
  const failing = new Set<UnifiedRole>()
  const failingLoad = new Set<UnifiedRole>()
  let challengerDown = false
  // Bridge contract for an unavailable paired directory: report the role as
  // unavailable and reject only its OWN load/select; never throw at render time.
  const down = (role: UnifiedRole): boolean => role === 'challenger' && challengerDown
  const downError = (): Error => new Error('the paired Challenger session is unavailable')
  const roles = {} as Record<UnifiedRole, UnifiedRoleController>
  for (const role of UNIFIED_ROLES) {
    const spy = spies[role]
    roles[role] = {
      available: () => !down(role) && !(options.absent ?? []).includes(role),
      readSelection: () => (down(role) ? undefined : spy.selections),
      subscribeSelection: (listener) => {
        if (down(role)) return () => undefined
        spy.listeners.add(listener)
        return () => { spy.listeners.delete(listener) }
      },
      loadCatalog: async () => {
        if (down(role)) throw downError()
        spy.loads += 1
        if (failingLoad.has(role)) throw new Error(`${role} catalog unavailable`)
        return catalog
      },
      select: async (provider, model, effort) => {
        if (down(role)) throw downError()
        spy.calls.push({ provider, model, effort })
        if (failing.has(role)) throw new Error(`${role} selection rejected`)
        spy.selections = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        for (const listener of spy.listeners) listener()
      },
    }
  }
  return {
    controller: { roles },
    spies,
    fail: (role) => { failing.add(role) },
    failLoad: (role) => { failingLoad.add(role) },
    succeedLoad: (role) => { failingLoad.delete(role) },
    setSelection: (role, selection) => {
      spies[role].selections = selection
      for (const listener of spies[role].listeners) listener()
    },
    breakChallenger: () => { challengerDown = true },
    repairChallenger: () => { challengerDown = false },
  }
}

function render(options: {
  preset?: string | undefined
  peer?: unknown
  plan?: unknown
  sessionId?: string
  harness?: Harness
} = {}): { container: HTMLElement; h: Harness } {
  const h = options.harness ?? harness()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const peer = 'peer' in options ? options.peer : pair()
  act(() => {
    root.render(createElement(UnifiedModelControl, {
      useProjection: (key: string) => {
        if (key === 'agentPreset') return options.preset ?? 'endeavour'
        if (key === 'endeavourPeer') return peer
        if (key === 'endeavourPlan') return 'plan' in options ? options.plan : null
        return null
      },
      sessionId: options.sessionId ?? 'session-root',
      unifiedModels: h.controller,
      t: undefined,
    } as never))
  })
  roots.push(root)
  containers.push(container)
  return { container, h }
}

const trigger = (container: HTMLElement): HTMLButtonElement | null => container.querySelector('[data-endeavour-unified-models]')
const menu = (): HTMLElement | null => document.body.querySelector('[data-endeavour-unified-pane]')
const menuRows = (): HTMLElement[] => [...(menu()?.querySelectorAll('[role="menuitem"],[role="menuitemradio"]') ?? [])] as HTMLElement[]
const sections = (): HTMLElement[] => [...(menu()?.querySelectorAll('[data-endeavour-section]') ?? [])] as HTMLElement[]

/** Flush the catalog loads plus one trigger click in a single act pass. */
async function open(container: HTMLElement): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await act(async () => { trigger(container)?.click(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('visibility and registration surface', () => {
  it('renders one icon-only trigger only for a paired Endeavour root', () => {
    const view = render({})
    const chip = trigger(view.container)
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('class')).toBe('dsh-endeavour-unified-trigger')
    expect(chip?.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    expect(chip?.getAttribute('aria-label')).toBe('Model settings: Endeavour and Challenger')
    expect(chip?.getAttribute('title')).toBe('Model settings: Endeavour and Challenger')
    // Icon-only: the sliders mark is the only visible content.
    expect(chip?.querySelector('[data-endeavour-unified-icon="sliders"]')).not.toBeNull()
    expect(chip?.textContent).toBe('')
    // Standard chats, the Challenger side and invalid pairs render nothing.
    expect(trigger(render({ preset: 'standard' }).container)).toBeNull()
    expect(trigger(render({ peer: pair(), sessionId: pair().challengerSessionId }).container)).toBeNull()
    expect(trigger(render({ peer: null }).container)).toBeNull()
    expect(trigger(render({ peer: { ...pair(), challengerSessionId: 'forged' } }).container)).toBeNull()
  })

  it('stays rendered when the paired Challenger directory cannot be resolved', () => {
    // The valid pair is the only gate. An unresolved paired directory is a
    // transient state reported INSIDE the menu; hiding here would drop the
    // native-seat hiding marker and expose the host selector.
    const absent = harness({ absent: ['challenger'] })
    const view = render({ harness: absent })
    expect(trigger(view.container)).not.toBeNull()
    const present = harness()
    expect(trigger(render({ harness: present }).container)).not.toBeNull()
  })

  it('disables the whole control while a plan is active instead of changing routes', () => {
    const view = render({ plan: { terminal: undefined } })
    const chip = trigger(view.container)
    expect(chip?.disabled).toBe(true)
    expect(chip?.getAttribute('title')).toBe('The Builder route is fixed while a plan is active')
    const done = render({ plan: { terminal: { outcome: 'completed', at: 1 } } })
    expect(trigger(done.container)?.disabled).toBe(false)
  })

  it('registers exactly one right-slot entry and no old split ids', async () => {
    vi.resetModules()
    const registrations: { name: string; id?: string; order?: number; locale?: string }[] = []
    const fakeClient = {
      effect: () => undefined,
      locale: { register: () => undefined },
      uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
      modelDirectories: { directoryFor: () => undefined },
      sessions: { binding: () => undefined, list: { getSnapshot: () => ({ current: 'session-root' }) } },
      slots: {
        inject: (_key: string, callback: () => unknown) => { callback() },
        register: (options: { name: string }, _component: unknown) => { registrations.push(options as never); return () => undefined },
      },
    }
    const { apply } = await import('../src/client/index.js')
    apply(fakeClient as never)
    const right = registrations.filter((entry) => entry.name === 'conversation.input.right')
    expect(right).toHaveLength(1)
    expect(right[0]).toMatchObject({ id: 'endeavour-models', order: 1000, locale: 'endeavour' })
    expect(registrations.some((entry) => entry.id === 'endeavour-challenger-model')).toBe(false)
    expect(registrations.some((entry) => entry.id === 'endeavour-role')).toBe(false)
  })
})

describe('menu structure and role targeting', () => {
  it('opens one menu with an Endeavour and a Challenger section, each with Model and Thinking', async () => {
    const view = render({})
    await open(view.container)
    expect(trigger(view.container)?.getAttribute('aria-expanded')).toBe('true')
    const pane = menu()
    expect(pane?.getAttribute('role')).toBe('menu')
    expect(pane?.getAttribute('aria-label')).toBe('Model settings: Endeavour and Challenger')
    expect(pane?.getAttribute('data-endeavour-unified-pane')).toBe('root')

    const headers = sections().map((node) => node.textContent)
    expect(headers).toEqual(['Endeavour', 'Challenger'])
    // Section headers are noninteractive and carry the role marks.
    expect(sections()[0]?.querySelector('[data-endeavour-role-icon="plan"]')).not.toBeNull()
    expect(sections()[1]?.querySelector('[data-endeavour-role-icon="execute"]')).not.toBeNull()
    expect(menu()?.querySelectorAll('[data-endeavour-section] button')).toHaveLength(0)

    const labels = menuRows().map((row) => `${row.querySelector('.dsh-endeavour-menu-cell-label')?.textContent}:${row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent}`)
    expect(labels).toEqual([
      'Model:Model One', 'Effort:Low',
      'Model:Model One', 'Effort:Low',
    ])
    // Both catalogs loaded once each, one per role.
    expect(view.h.spies.endeavour.loads).toBe(1)
    expect(view.h.spies.challenger.loads).toBe(1)
  })

  it('drills into one role catalog, keeps full names, and writes only that role', async () => {
    const view = render({})
    await open(view.container)
    const modelCell = menuRows().filter((row) => row.textContent?.includes('Model'))[1]
    await act(async () => { (modelCell as HTMLElement).click() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('model:challenger')
    const names = menuRows().map((row) => row.textContent)
    expect(names).toContain('Model One')
    expect(names).toContain('Model Two')
    expect(names.some((name) => name?.includes('…'))).toBe(false)

    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    // Only the Challenger directory was written, and the model's declared
    // default effort was applied to that role alone.
    expect(view.h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(view.h.spies.endeavour.calls).toEqual([])
    expect(view.h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('resets only the selected role effort to the catalog default', async () => {
    const view = render({})
    await open(view.container)
    const endeavourModel = menuRows().filter((row) => row.textContent?.includes('Model'))[0]
    await act(async () => { (endeavourModel as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model One')
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    expect(view.h.spies.endeavour.calls).toEqual([{ provider: 'p1', model: 'm1', effort: 'low' }])
    expect(view.h.spies.challenger.calls).toEqual([])
    expect(view.h.spies.challenger.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('offers only the drilled role thinking options and preserves its model', async () => {
    const view = render({})
    await open(view.container)
    const thinking = menuRows().filter((row) => row.textContent?.includes('Effort'))[0]
    await act(async () => { (thinking as HTMLElement).click() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('thinking:endeavour')
    const options = menuRows().map((row) => row.textContent)
    expect(options).toEqual(['Default', 'Low', 'High'])
    const high = menuRows().find((row) => row.textContent === 'High')
    await act(async () => { (high as HTMLElement).click(); await Promise.resolve() })
    expect(view.h.spies.endeavour.calls).toEqual([{ provider: 'p1', model: 'm1', effort: 'high' }])
    expect(view.h.spies.challenger.calls).toEqual([])
  })

  it('mirrors both roles live through their own subscriptions', async () => {
    const view = render({})
    await open(view.container)
    await act(async () => { view.h.setSelection('challenger', { provider: 'p1', model: 'm2' }); await Promise.resolve() })
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model One', 'Low', 'Model Two', 'Not available'])
    // The Endeavour row is untouched by the Challenger subscription.
    expect(view.h.spies.endeavour.listeners.size).toBe(1)
    expect(view.h.spies.challenger.listeners.size).toBe(1)
  })
})

describe('failure handling and keyboard', () => {
  it('reports a rejected write locally without changing either displayed selection', async () => {
    const view = render({})
    view.h.fail('challenger')
    await open(view.container)
    const modelCell = menuRows().filter((row) => row.textContent?.includes('Model'))[1]
    await act(async () => { (modelCell as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() })
    expect(view.h.spies.challenger.calls).toHaveLength(1)
    // The failure is reported locally on the next open, and the mirror still
    // shows the persisted selection for BOTH roles.
    await open(view.container)
    expect(menu()?.textContent).toContain('Could not save the Builder route')
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model One', 'Low', 'Model One', 'Low'])
  })

  it('returns to the root pane on Escape and closes on outside click', async () => {
    const view = render({})
    await open(view.container)
    const modelCell = menuRows().filter((row) => row.textContent?.includes('Model'))[0]
    await act(async () => { (modelCell as HTMLElement).click() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('model:endeavour')

    await act(async () => { menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('root')

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    expect(trigger(view.container)?.getAttribute('aria-expanded')).toBe('false')
  })

  it('wraps keyboard focus over the enabled rows and activates with Enter', async () => {
    const view = render({})
    await open(view.container)
    await act(async () => { menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(menu()?.querySelector('[class*="menu-cell--active"]')?.textContent).toContain('Effort')
    await act(async () => { menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('thinking:endeavour')
  })

  it('renders the menu through a portal with scroll and resize placement tracking', async () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    expect(source).toContain('createPortal(')
    expect(source).toContain('document.body')
    expect(source).toContain('getBoundingClientRect()')
    expect(source).toContain("window.addEventListener('scroll', place, true)")
    expect(source).toContain("window.addEventListener('resize', place)")
    expect(source).toContain("visibility: 'hidden'")
    // Both roles resolve through the official directory API, never a remote call.
    expect(source).not.toContain('remote.')
    const view = render({})
    await open(view.container)
    expect(menu()?.parentElement).toBe(document.body)
  })

  it('renders nothing before any projection arrives', () => {
    const html = renderToStaticMarkup(createElement(UnifiedModelControl, {
      useProjection: () => null,
      sessionId: 'session-root',
      unifiedModels: harness().controller,
      t: undefined,
    } as never))
    expect(html).toBe('')
  })
})

/**
 * The installed ModelDirectory resolver throws for a session without a live
 * scope/binding instead of returning undefined, so a transient Challenger
 * outage used to escape the render-time availability gate: React unmounted the
 * control, the composer lost its trigger, and the native Endeavour selector
 * reappeared through the CSS fallback.
 */
describe('transient Challenger directory failure', () => {
  class Boundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
    override state = { failed: false }
    static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
    override render(): ReactNode {
      return this.state.failed ? createElement('div', { 'data-boundary-fallback': '' }) : this.props.children
    }
  }

  function renderGuarded(h: Harness): HTMLElement {
    const container = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    container.appendChild(card)
    document.body.appendChild(container)
    const root = createRoot(card)
    act(() => {
      root.render(createElement(Boundary, null, createElement(UnifiedModelControl, {
        useProjection: (key: string) => {
          if (key === 'agentPreset') return 'endeavour'
          if (key === 'endeavourPeer') return pair()
          return null
        },
        sessionId: 'session-root',
        unifiedModels: h.controller,
        t: undefined,
      } as never)))
    })
    roots.push(root)
    containers.push(container)
    return container
  }

  it('keeps the trigger mounted and both sections present while the Challenger directory throws', async () => {
    const h = harness()
    const container = renderGuarded(h)
    expect(trigger(container)).not.toBeNull()

    // The paired directory goes away mid-session; opening the menu must not
    // unmount the control or its native-seat hiding marker.
    h.breakChallenger()
    await act(async () => { trigger(container)?.click(); await Promise.resolve() })
    expect(container.querySelector('[data-boundary-fallback]')).toBeNull()
    expect(trigger(container)).not.toBeNull()
    expect(container.querySelector('[data-composer-card]')?.querySelector('[data-endeavour-unified-models]')).not.toBeNull()
    expect(menu()).not.toBeNull()
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(menu()?.querySelectorAll('.dsh-endeavour-menu-cell')).toHaveLength(4)

    // Only the unavailable role is degraded, and it offers a local retry.
    const cells = [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell') ?? [])] as HTMLButtonElement[]
    expect(cells.map((cell) => cell.disabled)).toEqual([false, false, true, true])
    expect(menu()?.textContent).toContain('Challenger is unavailable')
    const retry = menu()?.querySelector('[data-endeavour-retry="challenger"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()

    // Repair: retry re-resolves only the Challenger directory.
    h.repairChallenger()
    await act(async () => { retry?.click(); await Promise.resolve(); await Promise.resolve() })
    const repaired = [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell') ?? [])] as HTMLButtonElement[]
    expect(repaired.map((cell) => cell.disabled)).toEqual([false, false, false, false])
    expect(menu()?.querySelector('[data-endeavour-retry="challenger"]')).toBeNull()
    expect(h.spies.endeavour.calls).toEqual([])
  })

  it('still renders one trigger after reopening the menu during an outage', async () => {
    const h = harness()
    const container = renderGuarded(h)
    h.breakChallenger()
    await act(async () => { trigger(container)?.click(); await Promise.resolve() })
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    await act(async () => { trigger(container)?.click(); await Promise.resolve() })
    expect(container.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(container.querySelector('[data-boundary-fallback]')).toBeNull()
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
  })
})

/**
 * The BRIDGE is where the resolver's throw is contained: the component keeps a
 * non-throwing controller, and only the unavailable role's own load/select
 * operations reject with a local error.
 */
describe('bridge contract for an unavailable paired session', () => {

  it('never throws for a paired session without a live scope, and keeps Endeavour working', async () => {
    const { controller, isUnavailableSessionError } = await bridge((id) => {
      if (id.startsWith('session-') && id !== 'session-root') {
        throw new Error(`ui-model-selection: session "${id}" resolved no scope`)
      }
      return undefined
    })
    expect(isUnavailableSessionError(new Error('ui-model-selection: session "x" resolved no binding'))).toBe(true)
    expect(isUnavailableSessionError(new Error('ui-model-selection: session "x" resolved no scope'))).toBe(true)
    expect(isUnavailableSessionError(new Error('boom'))).toBe(false)
    expect(isUnavailableSessionError('not an error')).toBe(false)

    // The render-time surface never throws.
    expect(controller.roles.challenger.available()).toBe(false)
    expect(controller.roles.challenger.readSelection()).toBeUndefined()
    expect(typeof controller.roles.challenger.subscribeSelection(() => undefined)).toBe('function')
    // Only that role's own operations reject, with the local description.
    await expect(controller.roles.challenger.loadCatalog()).rejects.toThrow('the paired Challenger session is unavailable')
    await expect(controller.roles.challenger.select('p1', 'm1', undefined)).rejects.toThrow('the paired Challenger session is unavailable')
    // The Endeavour role keeps its own official directory.
    expect(controller.roles.endeavour.available()).toBe(true)
    expect(controller.roles.endeavour.readSelection()).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
    await expect(controller.roles.endeavour.loadCatalog()).resolves.toBeDefined()
  })

  it('still propagates an unrelated resolver failure', async () => {
    const { controller } = await bridge(() => { throw new Error('ui-model-selection: catalog exploded') })
    expect(() => controller.roles.endeavour.available()).toThrow('catalog exploded')
  })
})

/**
 * Live composer composition: `InputBar.tsx:525-528` renders
 * `conversation.input.right` (this control) and `conversation.input.model` (the
 * host-owned native seat) as SIBLINGS in one composer card, so the single
 * `:has([data-endeavour-unified-models])` rule is the whole fallback story.
 */
describe('live composer composition', () => {
  function mountComposer(h: Harness): { card: HTMLElement; right: HTMLElement; seat: HTMLElement } {
    const container = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const right = document.createElement('div')
    right.setAttribute('data-slot', 'conversation.input.right')
    const seat = document.createElement('div')
    seat.setAttribute('data-slot', 'conversation.input.model')
    seat.appendChild(document.createElement('button'))
    card.append(right, seat)
    container.appendChild(card)
    document.body.appendChild(container)
    const root = createRoot(right)
    act(() => {
      root.render(createElement(UnifiedModelControl, {
        useProjection: (key: string) => {
          if (key === 'agentPreset') return 'endeavour'
          if (key === 'endeavourPeer') return pair()
          return null
        },
        sessionId: 'session-root',
        unifiedModels: h.controller,
        t: undefined,
      } as never))
    })
    roots.push(root)
    containers.push(container)
    return { card, right, seat }
  }

  it('keeps the control a sibling of the native seat, hidden through open, error and retry', async () => {
    const h = harness()
    const { card, right, seat } = mountComposer(h)
    // Sibling topology, exactly as the composer builds it.
    expect(right.nextElementSibling).toBe(seat)
    expect(right.querySelector('[data-endeavour-unified-models]')).not.toBeNull()
    expect(markerSeat(card)).toBe(seat)

    // Healthy open: both sections, accessible menu, seat still hidden.
    await act(async () => { trigger(right)?.click(); await Promise.resolve() })
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(menu()?.getAttribute('role')).toBe('menu')
    expect(menu()?.getAttribute('aria-label')).toBe('Model settings: Endeavour and Challenger')
    expect(markerSeat(card)).toBe(seat)

    // Outage while open: the retry row re-renders without unmounting anything.
    h.breakChallenger()
    await act(async () => {
      h.setSelection('endeavour', { provider: 'p1', model: 'm1', reasoningEffort: 'low' })
      await Promise.resolve()
    })
    const retry = menu()?.querySelector('[data-endeavour-retry="challenger"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    const cells = () => [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell') ?? [])] as HTMLButtonElement[]
    expect(cells().map((cell) => cell.disabled)).toEqual([false, false, true, true])
    expect(markerSeat(card)).toBe(seat)
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])

    // Retry while still down changes nothing but keeps the control mounted.
    await act(async () => { retry?.click(); await Promise.resolve() })
    expect(markerSeat(card)).toBe(seat)
    expect(trigger(right)?.getAttribute('aria-expanded')).toBe('true')
    expect(sections()).toHaveLength(2)

    // Repair: retry re-resolves only Challenger, restores its rows and its
    // catalog, and the seat stays hidden.
    h.repairChallenger()
    await act(async () => {
      (menu()?.querySelector('[data-endeavour-retry="challenger"]') as HTMLButtonElement | null)?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(cells().map((cell) => cell.disabled)).toEqual([false, false, false, false])
    expect(menu()?.querySelector('[data-endeavour-retry="challenger"]')).toBeNull()
    expect(h.spies.challenger.loads).toBeGreaterThan(1)
    expect(markerSeat(card)).toBe(seat)

    // Closing and reopening keeps exactly one trigger and the same condition.
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(card)).toBe(seat)
    await act(async () => { trigger(right)?.click(); await Promise.resolve() })
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(cells()).toHaveLength(4)
  })

  it('survives an asynchronous catalog failure and recovers on retry without touching the other role', async () => {
    const h = harness()
    h.failLoad('challenger')
    const { card, right } = mountComposer(h)
    await act(async () => { trigger(right)?.click(); await Promise.resolve(); await Promise.resolve() })
    // Both sections stay, and only the failing role reports the load error.
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    const values = () => [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell-value') ?? [])].map((node) => node.textContent)
    // The persisted selection stays visible (raw ids without a catalog) and the
    // failure is reported where it can be acted on, not as a vanished section.
    expect(values()).toEqual(['Model One', 'Low', 'm1', 'Not available'])
    expect(markerSeat(card)).toBe(card.querySelector('[data-slot="conversation.input.model"]'))

    // Drilling into the failing role offers its own retry.
    const cells = [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell') ?? [])] as HTMLButtonElement[]
    await act(async () => { cells[2]?.click(); await Promise.resolve() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('model:challenger')
    expect(menu()?.textContent).toContain('Could not load models')
    const loadsBefore = h.spies.challenger.loads
    h.succeedLoad('challenger')
    await act(async () => {
      (menu()?.querySelector('[data-endeavour-retry="challenger"]') as HTMLButtonElement | null)?.click()
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    // The load was attempted again and now lists the full catalog names.
    expect(h.spies.challenger.loads).toBeGreaterThan(loadsBefore)
    expect(menuRows().map((row) => row.textContent)).toContain('Model One')
    expect(h.spies.endeavour.calls).toEqual([])
    expect(markerSeat(card)).not.toBeNull()
  })
})

/**
 * Live projection jitter: opening the menu publishes local state, and if the
 * `endeavourPeer` projection blips during that render the control must keep its
 * established identity. Today the gate re-reads the live projection, so the
 * trigger unmounts, the native-seat hiding marker disappears and the host
 * Endeavour selector is exposed again.
 */
interface Registration { id?: string; inject?: (sessionId: string) => { unifiedModels: UnifiedModelController } }

async function bridge(directoryFor: (id: string) => unknown): Promise<{
  controller: UnifiedModelController
  isUnavailableSessionError: (error: unknown) => boolean
  setPeer: (value: unknown) => void
}> {
  vi.resetModules()
  const pairState = pair()
  const registrations: Registration[] = []
  let peerValue: unknown = pairState
  const faces = new Map<string, unknown>([
    ['session-root:endeavourPeer', { getSnapshot: () => peerValue, subscribe: () => () => undefined }],
  ])
  const working = {
    store: {
      getSnapshot: () => ({ current: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } }),
      subscribe: () => () => undefined,
    },
    load: async () => catalog,
    select: async () => undefined,
  }
  const fakeClient = {
    effect: () => undefined,
    locale: { register: () => undefined },
    uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
    modelDirectories: { directoryFor: (id: string) => directoryFor(id) ?? working },
    sessions: {
      binding: (id: string) => ({ session: { projections: { faceOf: (key: string) => faces.get(`${id}:${key}`) } } }),
      list: { getSnapshot: () => ({ current: 'session-root' }), subscribe: () => () => undefined },
    },
    slots: {
      inject: (_key: string, callback: () => unknown) => { callback() },
      register: (options: Registration) => { registrations.push(options); return () => undefined },
    },
  }
  const module = await import('../src/client/index.js')
  module.apply(fakeClient as never)
  const entry = registrations.find((options) => options.id === 'endeavour-models')
  const controller = entry?.inject?.('session-root').unifiedModels
  expect(controller).toBeDefined()
  return {
    controller: controller as UnifiedModelController,
    isUnavailableSessionError: module.isUnavailableSessionError,
    setPeer: (value: unknown) => { peerValue = value },
  }
}


function renderJittery(options: { peer: () => unknown; sessionId?: string; harness?: Harness }): {
  card: HTMLElement
  right: HTMLElement
  seat: HTMLElement
  draw: () => void
  h: Harness
} {
  const h = options.harness ?? harness()
  const container = document.createElement('div')
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const right = document.createElement('div')
  right.setAttribute('data-slot', 'conversation.input.right')
  const seat = document.createElement('div')
  seat.setAttribute('data-slot', 'conversation.input.model')
  card.append(right, seat)
  container.appendChild(card)
  document.body.appendChild(container)
  const root = createRoot(right)
  const draw = (): void => {
    act(() => {
      root.render(createElement(UnifiedModelControl, {
        useProjection: (key: string) => {
          if (key === 'agentPreset') return 'endeavour'
          if (key === 'endeavourPeer') return options.peer()
          return null
        },
        sessionId: options.sessionId ?? 'session-root',
        unifiedModels: h.controller,
        t: undefined,
      } as never))
    })
  }
  draw()
  roots.push(root)
  containers.push(container)
  return { card, right, seat, draw, h }
}

const markerSeat = (card: HTMLElement): Element | null =>
  card.querySelector('[data-composer-card]:has([data-endeavour-unified-models]) [data-slot="conversation.input.model"]')
describe('peer projection jitter', () => {
  it('keeps the trigger, the seat marker and both sections through a projection blip', async () => {
    let peer: unknown = pair()
    const view = renderJittery({ peer: () => peer })
    expect(trigger(view.right)).not.toBeNull()
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect(menu()).not.toBeNull()
    expect(markerSeat(view.card)).not.toBeNull()

    // The projection publishes null while local menu state renders.
    peer = null
    view.draw()
    expect(trigger(view.right)).not.toBeNull()
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(view.card)).not.toBeNull()
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])

    // A malformed snapshot of an established pair is not a licence to unmount.
    peer = { ...pair(), challengerSessionId: 'forged' }
    view.draw()
    expect(trigger(view.right)).not.toBeNull()
    expect(markerSeat(view.card)).not.toBeNull()

    // Nor is a valid projection belonging to a different root.
    peer = pair('session-other')
    view.draw()
    expect(trigger(view.right)).not.toBeNull()
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])

    // Recovery is silent: the same single control keeps working.
    peer = pair()
    view.draw()
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
  })

  it('keeps the validated Challenger target across a projection gap', async () => {
    const { controller, setPeer } = await bridge(() => undefined)
    expect(controller.roles.challenger.available()).toBe(true)
    const before = controller.roles.challenger.readSelection()
    expect(before).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })

    // The pair is durable; only the projection blips.
    setPeer(null)
    expect(controller.roles.challenger.available()).toBe(true)
    expect(controller.roles.challenger.readSelection()).toEqual(before)
    await expect(controller.roles.challenger.loadCatalog()).resolves.toBeDefined()

    // Malformed data can never become a target either.
    setPeer({ ...pair(), challengerSessionId: 'forged' })
    expect(controller.roles.challenger.readSelection()).toEqual(before)

    // A VALID pair of a different root is not this session's counterpart.
    setPeer(pair('session-other'))
    expect(controller.roles.challenger.readSelection()).toEqual(before)
    expect(controller.roles.challenger.available()).toBe(true)

    // A later valid projection of the same pair refreshes the same identity.
    setPeer(pair())
    expect(controller.roles.challenger.readSelection()).toEqual(before)
  })
})

/**
 * Full composer state sequence against the sibling right/model slots:
 * valid pair -> open -> projection blip -> write through the retained target ->
 * close/reopen while still in the gap -> silent recovery.
 */
describe('composer state sequence', () => {
  const cells = (): HTMLButtonElement[] =>
    [...(menu()?.querySelectorAll('.dsh-endeavour-menu-cell') ?? [])] as HTMLButtonElement[]

  it('keeps one trigger, four rows and the hidden native seat through the whole sequence', async () => {
    let peer: unknown = pair()
    const view = renderJittery({ peer: () => peer })

    // 1. valid pair: admitted, marker set, nothing else.
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(view.card)).toBe(view.seat)

    // 2. open: both sections and four Model/Thinking rows.
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(cells()).toHaveLength(4)
    expect(cells().map((cell) => cell.disabled)).toEqual([false, false, false, false])
    expect(markerSeat(view.card)).toBe(view.seat)

    // 3. blip while open: control, marker and rows survive.
    peer = null
    view.draw()
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(view.card)).toBe(view.seat)
    expect(cells()).toHaveLength(4)
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])

    // 4. a write through the RETAINED Challenger directory still works during the gap.
    await act(async () => { cells()[2]!.click(); await Promise.resolve() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('model:challenger')
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    expect(view.h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(view.h.spies.endeavour.calls).toEqual([])

    // 5. malformed snapshot + close/reopen while still in the gap.
    peer = { ...pair(), challengerSessionId: 'forged' }
    view.draw()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(view.card)).toBe(view.seat)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(cells()).toHaveLength(4)

    // 6. recovery: still exactly one control, same marker, rows intact.
    peer = pair()
    view.draw()
    expect(view.right.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(1)
    expect(markerSeat(view.card)).toBe(view.seat)
    expect(cells()).toHaveLength(4)
    expect(menuRows().some((row) => row.textContent?.includes('Model One'))).toBe(true)
  })

  it('degrades only the unavailable role and keeps the other one writing', async () => {
    const h = harness({ absent: ['challenger'] })
    const view = renderJittery({ peer: () => pair(), harness: h })
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })

    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    expect(cells()).toHaveLength(4)
    expect(cells().map((cell) => cell.disabled)).toEqual([false, false, true, true])
    expect(menu()?.querySelector('[data-endeavour-retry="challenger"]')).not.toBeNull()
    expect(markerSeat(view.card)).toBe(view.seat)

    // The Endeavour role stays fully usable and writes only its own target.
    await act(async () => { cells()[0]!.click(); await Promise.resolve() })
    expect(menu()?.getAttribute('data-endeavour-unified-pane')).toBe('model:endeavour')
    const option = menuRows().find((row) => row.textContent === 'Model One')
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    expect(h.spies.endeavour.calls).toEqual([{ provider: 'p1', model: 'm1', effort: 'low' }])
    expect(h.spies.challenger.calls).toEqual([])
  })
})
