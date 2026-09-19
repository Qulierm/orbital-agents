// @vitest-environment happy-dom
/**
 * Unified Endeavour + Challenger model control: one registration, one icon-only
 * trigger, one menu with a section per role, role-targeted directory reads,
 * subscriptions, catalog loads and writes, independent model/thinking state,
 * model-default effort reset, local error reporting and keyboard behaviour.
 */

import { readFileSync } from 'node:fs'
import { Component, createElement, useState, type ReactNode } from 'react'
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
import { MENU_DETAIL_MAX, safeDiagnostic, sameSelection } from '../src/client/UnifiedModelControl.js'
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
  /** Count of readSelection calls, used to prove render purity. */
  reads: number
  /** Count of disposer invocations, used to prove at-most-once cleanup. */
  disposals: number
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
  /** Every operation of that role throws an UNEXPECTED error. */
  breakRole(role: UnifiedRole, message?: string): void
  /** Only one named operation throws, the rest keep working. */
  breakOperation(role: UnifiedRole, operation: 'readSelection' | 'available' | 'subscribeSelection', message?: string): void
  repairRole(role: UnifiedRole): void
  /** Models the bridge's peer-validation half of admission. */
  setPairValid(valid: boolean): void
  /** Notifies subscribers synchronously inside subscribeSelection. */
  syncNotify: boolean
  /** Makes the disposer of that role throw, to test cleanup containment. */
  breakDisposer(role: UnifiedRole): void
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
    endeavour: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0, reads: 0, disposals: 0 },
    challenger: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0, reads: 0, disposals: 0 },
  }
  if ('endeavour' in options) spies.endeavour.selections = options.endeavour
  if ('challenger' in options) spies.challenger.selections = options.challenger
  const failing = new Set<UnifiedRole>()
  const failingLoad = new Set<UnifiedRole>()
  const broken = new Set<UnifiedRole>()
  const brokenOps = new Set<string>()
  const brokenMessage = new Map<string, string>()
  const boom = (role: UnifiedRole, operation: 'readSelection' | 'available' | 'subscribeSelection'): void => {
    const key = `${role}.${operation}`
    if (!broken.has(role) && !brokenOps.has(key)) return
    throw new Error(brokenMessage.get(key) ?? brokenMessage.get(role) ?? `${role} controller exploded`)
  }
  let challengerDown = false
  let syncNotify = false
  const brokenDisposers = new Set<UnifiedRole>()
  // Bridge contract for an unavailable paired directory: report the role as
  // unavailable and reject only its OWN load/select; never throw at render time.
  const down = (role: UnifiedRole): boolean => role === 'challenger' && challengerDown
  const downError = (): Error => new Error('the paired Challenger session is unavailable')
  const roles = {} as Record<UnifiedRole, UnifiedRoleController>
  for (const role of UNIFIED_ROLES) {
    const spy = spies[role]
    roles[role] = {
      available: () => { boom(role, 'available'); return !down(role) && !(options.absent ?? []).includes(role) },
      readSelection: () => {
        boom(role, 'readSelection')
        spy.reads += 1
        return down(role) ? undefined : spy.selections
      },
      subscribeSelection: (listener) => {
        boom(role, 'subscribeSelection')
        if (down(role)) return () => undefined
        spy.listeners.add(listener)
        // A real directory may notify the new subscriber synchronously.
        if (syncNotify) listener()
        return () => {
          spy.disposals += 1
          spy.listeners.delete(listener)
          if (brokenDisposers.has(role)) throw new Error(`${role} disposer exploded`)
        }
      },
      loadCatalog: async () => {
        boom(role, 'available')
        if (down(role)) throw downError()
        spy.loads += 1
        if (failingLoad.has(role)) throw new Error(`${role} catalog unavailable`)
        return catalog
      },
      select: async (provider, model, effort) => {
        boom(role, 'available')
        if (down(role)) throw downError()
        spy.calls.push({ provider, model, effort })
        if (failing.has(role)) throw new Error(`${role} selection rejected`)
        spy.selections = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        for (const listener of spy.listeners) listener()
      },
    }
  }
  // Admission mirrors the bridge contract: granted on an explicit `endeavour`
  // preset plus a valid pair, kept through transient nulls, revoked only by an
  // explicit other preset.
  let pairValid = true
  let admitted = false
  return {
    controller: {
      roles,
      admit: (preset: string | undefined) => {
        if (preset !== undefined && preset !== 'endeavour') admitted = false
        if (!admitted && preset === 'endeavour' && pairValid) admitted = true
        return admitted
      },
    },
    spies,
    fail: (role) => { failing.add(role) },
    failLoad: (role) => { failingLoad.add(role) },
    breakRole: (role, message) => { broken.add(role); if (message !== undefined) brokenMessage.set(role, message) },
    breakOperation: (role, operation, message) => {
      const key = `${role}.${operation}`
      brokenOps.add(key)
      if (message !== undefined) brokenMessage.set(key, message)
    },
    repairRole: (role) => {
      broken.delete(role)
      for (const key of [...brokenOps]) if (key.startsWith(`${role}.`)) brokenOps.delete(key)
    },
    setPairValid: (valid) => { pairValid = valid },
    get syncNotify() { return syncNotify },
    set syncNotify(value: boolean) { syncNotify = value },
    breakDisposer: (role) => { brokenDisposers.add(role) },
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
/** Newest portal in document order: earlier mounted views may still be present. */
const newest = (selector: string): Element | null =>
  [...document.body.querySelectorAll(selector)].at(-1) ?? null
/** Diagnostics text of the newest menu error surface. */
const detailText = (): string => newest('[data-endeavour-menu-error-detail]')?.textContent ?? ''
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
    // Standard never admits, and the bridge refuses the Challenger side of the
    // pair (proven directly in the bridge suite below), which this harness
    // models through its peer-validity flag.
    const unpaired = harness()
    unpaired.setPairValid(false)
    expect(trigger(render({ preset: 'standard' }).container)).toBeNull()
    expect(trigger(render({ peer: pair(), sessionId: pair().challengerSessionId, harness: unpaired }).container)).toBeNull()
    expect(trigger(render({ peer: null, harness: unpaired }).container)).toBeNull()
    expect(trigger(render({ peer: { ...pair(), challengerSessionId: 'forged' }, harness: unpaired }).container)).toBeNull()
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

  it('admits only a validated Endeavour-side pair and keeps it through jitter', async () => {
    // The directory itself throws: admission must not depend on it.
    const { controller, setPeer } = await bridge(() => { throw new Error('ui-model-selection: session \"x\" resolved no scope') })
    expect(controller.admit?.('endeavour')).toBe(true)
    // Transient gaps keep the admission.
    setPeer(null)
    expect(controller.admit?.(undefined)).toBe(true)
    setPeer({ ...pair(), challengerSessionId: 'forged' })
    expect(controller.admit?.('endeavour')).toBe(true)
    // Only an explicit other preset revokes it, and it can be re-admitted after.
    expect(controller.admit?.('standard')).toBe(false)
    setPeer(pair())
    expect(controller.admit?.('endeavour')).toBe(true)
  })

  it('never admits a Challenger-side or unpaired session', async () => {
    const { controller } = await bridge(() => undefined)
    expect(controller.admit?.('endeavour')).toBe(true)
    // A separate controller for the Challenger side of the same pair.
    const other = await bridge(() => undefined, pair().challengerSessionId)
    expect(other.controller.admit?.('endeavour')).toBe(false)
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

    // Outage: availability is a post-commit snapshot, so the control neither
    // unmounts nor re-probes during a render; reopening re-probes both roles and
    // the Challenger then reports the outage locally.
    h.breakChallenger()
    await act(async () => {
      h.setSelection('endeavour', { provider: 'p1', model: 'm1', reasoningEffort: 'low' })
      await Promise.resolve()
    })
    expect(markerSeat(card)).toBe(seat)
    expect(trigger(right)?.getAttribute('aria-expanded')).toBe('true')
    expect(sections().map((node) => node.textContent)).toEqual(['Endeavour', 'Challenger'])
    await act(async () => { trigger(right)?.click(); await Promise.resolve() })
    await act(async () => { trigger(right)?.click(); await Promise.resolve(); await Promise.resolve() })
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

async function bridge(directoryFor: (id: string) => unknown, sessionId = 'session-root'): Promise<{
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
  const controller = entry?.inject?.(sessionId).unifiedModels
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

/**
 * Remaining live disappearance paths.
 *
 * Two independent projection facts feed the render gate today: the peer view
 * (latched in a component-local ref) and the live `agentPreset`
 * (`builderControlDisabled`). A null preset after opening, a slot remount, or an
 * unexpected exception from a role operation each remove the whole control —
 * and with it the `:has([data-endeavour-unified-models])` marker that keeps the
 * host's native selector hidden.
 */
describe('persistent admission', () => {
  class OuterBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
    override state = { failed: false }
    static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
    override render(): ReactNode {
      return this.state.failed ? createElement('div', { 'data-outer-fallback': '' }) : this.props.children
    }
  }

  interface Slot {
    readonly card: HTMLElement
    readonly right: HTMLElement
    readonly seat: HTMLElement
    readonly h: Harness
    draw(): void
    remount(): void
    dispose(): void
    setPreset(value: string | undefined): void
    setPeer(value: unknown): void
  }

  /** Sibling-slot harness with independently mutable preset and peer facts. */
  function slot(h: Harness = harness(), initial: { preset?: string | undefined; peer?: unknown } = {}): Slot {
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
    containers.push(container)
    let preset: string | undefined = 'preset' in initial ? initial.preset : 'endeavour'
    let peer: unknown = 'peer' in initial ? initial.peer : pair()
    let root: Root | undefined
    const draw = (): void => {
      root?.unmount()
      root = createRoot(right)
      roots.push(root)
      act(() => {
        root?.render(createElement(OuterBoundary, null, createElement(UnifiedModelControl, {
          useProjection: (key: string) => {
            if (key === 'agentPreset') return preset
            if (key === 'endeavourPeer') return peer
            return null
          },
          sessionId: 'session-root',
          unifiedModels: h.controller,
          t: undefined,
        } as never)))
      })
    }
    draw()
    return {
      card, right, seat, h, draw,
      remount: () => { draw() },
      dispose: () => {
        act(() => { root?.unmount() })
        container.remove()
        const index = containers.indexOf(container)
        if (index >= 0) containers.splice(index, 1)
      },
      setPreset: (value) => { preset = value },
      setPeer: (value) => { peer = value },
    }
  }

  const marker = (card: HTMLElement): Element | null =>
    card.querySelector('[data-composer-card]:has([data-endeavour-unified-models]) [data-slot="conversation.input.model"]')
  const triggers = (right: HTMLElement): number => right.querySelectorAll('[data-endeavour-unified-models]').length

  it('keeps the control when agentPreset publishes null after opening', async () => {
    const view = slot()
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect(triggers(view.right)).toBe(1)
    view.setPreset(undefined)
    view.draw()
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
  })

  it('survives a full remount during a transient null preset and peer', () => {
    const view = slot()
    expect(triggers(view.right)).toBe(1)
    view.setPreset(undefined)
    view.setPeer(null)
    view.remount()
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
    // Recovery stays a single control.
    view.setPreset('endeavour')
    view.setPeer(pair())
    view.remount()
    expect(triggers(view.right)).toBe(1)
  })

  it('keeps the trigger and marker when a role operation throws after opening', async () => {
    const h = harness()
    const view = slot(h)
    expect(triggers(view.right)).toBe(1)
    // An unexpected initialization failure inside the menu subtree: opening the
    // menu now throws while the role bridge is broken.
    h.breakRole('endeavour')
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    // The shell survives: no outer fallback, trigger and marker intact.
    expect(view.right.querySelector('[data-outer-fallback]')).toBeNull()
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
    // A localized retry surface replaces only the menu content.
    expect(document.body.querySelector('[data-endeavour-menu-error]')?.textContent).toContain('Model settings unavailable')
    const retry = document.body.querySelector('[data-endeavour-menu-retry]') as HTMLElement | null
    expect(retry).not.toBeNull()
    // Recovery: repairing the role and retrying renders the normal menu.
    h.repairRole('endeavour')
    await act(async () => { (retry as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() })
    expect(newest('[data-endeavour-menu-error]')).toBeNull()
    expect(newest('[data-endeavour-unified-pane]')).not.toBeNull()
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
    view.dispose()
  })

  it('revokes only on an explicit later non-Endeavour preset', () => {
    const view = slot()
    expect(triggers(view.right)).toBe(1)
    view.setPreset('standard')
    view.draw()
    expect(triggers(view.right)).toBe(0)
  })

  it('still renders nothing for never-admitted sessions', () => {
    const cases: readonly (readonly [string | undefined, unknown, boolean])[] = [
      ['standard', pair(), true],
      [undefined, pair(), true],
      ['challenger', pair(), true],
      // The bridge refuses admission when the peer half is not validated.
      ['endeavour', null, false],
      ['endeavour', { ...pair(), challengerSessionId: 'forged' }, false],
      ['endeavour', pair('session-other'), false],
    ]
    for (const [preset, peer, valid] of cases) {
      const h = harness()
      h.setPairValid(valid)
      // The session must never have been admitted: start from these facts.
      const view = slot(h, { preset, peer })
      expect(triggers(view.right), `preset=${String(preset)} valid=${String(valid)}`).toBe(0)
      expect(marker(view.card), `preset=${String(preset)} valid=${String(valid)}`).toBeNull()
      // And they stay hidden after a remount.
      view.remount()
      expect(triggers(view.right), `after remount preset=${String(preset)}`).toBe(0)
    }
  })

  it('revokes admission only on an explicit non-Endeavour preset', () => {
    const h = harness()
    const view = slot(h)
    expect(triggers(view.right)).toBe(1)
    // A transient null never revokes.
    view.setPreset(undefined)
    view.remount()
    expect(triggers(view.right)).toBe(1)
    // An explicit other preset does.
    view.setPreset('standard')
    view.remount()
    expect(triggers(view.right)).toBe(0)
    // And it can be admitted again afterwards.
    view.setPreset('endeavour')
    view.remount()
    expect(triggers(view.right)).toBe(1)
  })

describe('safe menu diagnostics', () => {
  const boundaryText = (): string => newest('[data-endeavour-menu-error]')?.textContent ?? ''
  const detailText = (): string => newest('[data-endeavour-menu-error-detail]')?.textContent ?? ''

  async function openBroken(h: Harness, message?: string): Promise<Slot> {
    const view = slot(h)
    h.breakRole('endeavour', message)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    return view
  }

  it('names the failing role and operation for every initial read', async () => {
    // Post-commit probing asks for availability first, so a fully broken role
    // surfaces that tag; a selection-only failure keeps its own tag.
    const cases: readonly (readonly [UnifiedRole, string])[] = [
      ['endeavour', 'endeavour.available:'],
      ['challenger', 'challenger.available:'],
    ]
    for (const [role, tag] of cases) {
      const h = harness()
      const view = slot(h)
      h.breakRole(role)
      await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
      expect(boundaryText()).toContain('Model settings unavailable')
      expect(detailText(), `role=${role}`).toContain(tag)
      expect(detailText()).toContain('controller exploded')
      expect(view.right.querySelector('[data-outer-fallback]')).toBeNull()
      view.dispose()
    }
  })

  it('tags availability and subscription failures too', async () => {
    const availability = harness()
    const availabilityView = slot(availability)
    availability.breakOperation('challenger', 'available')
    await act(async () => { trigger(availabilityView.right)?.click(); await Promise.resolve() })
    expect(detailText()).toContain('challenger.available:')
    expect(availabilityView.right.querySelector('[data-outer-fallback]')).toBeNull()
    availabilityView.dispose()

    const subscription = harness()
    const subscriptionView = slot(subscription)
    subscription.breakOperation('endeavour', 'subscribeSelection')
    await act(async () => { trigger(subscriptionView.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(detailText()).toContain('endeavour.subscribeSelection:')
    expect(triggers(subscriptionView.right)).toBe(1)
  })

  it('formats the diagnostic safely on its own', () => {
    expect(safeDiagnostic(new Error('  spaced\n\tmessage\u0007 '))).toBe('spaced message')
    expect(safeDiagnostic(new TypeError('typed'))).toBe('TypeError: typed')
    expect(safeDiagnostic(new Error('x'.repeat(500)))).toHaveLength(MENU_DETAIL_MAX)
    expect(safeDiagnostic('not an error')).toBeUndefined()
    expect(safeDiagnostic(new Error('   '))).toBeUndefined()
  })

  it('tags a selection-only failure with readSelection', async () => {
    const h = harness()
    const view = slot(h)
    h.breakOperation('endeavour', 'readSelection')
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect(detailText()).toContain('endeavour.readSelection:')
    view.dispose()
  })

  it('normalizes whitespace, strips control characters and caps the detail', async () => {
    const h = harness()
    const long = 'boom\n\tsecond line ' + 'x'.repeat(400) + '\u0007tail'
    await openBroken(h, long)
    const detail = detailText()
    expect(detail).toContain('endeavour.available:')
    expect(detail).not.toMatch(/[\n\t\u0000-\u001f\u007f]/)
    expect(detail).toContain('Details: ')
    // Tag plus the injected message, capped at the exported bound.
    expect(detail.length).toBeLessThanOrEqual('Details: '.length + MENU_DETAIL_MAX)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('never exposes a stack or object serialization', async () => {
    await openBroken(harness())
    const detail = detailText()
    expect(detail).not.toContain('\n    at ')
    expect(detail.toLowerCase()).not.toContain('stack')
    expect(detail).not.toMatch(/\.ts:\d+/)
    expect(detail).not.toContain('{')
    // The generic copy still renders alongside the detail.
    expect(boundaryText()).toContain('Model settings unavailable')
  })

  it('keeps expected role-unavailable errors role-local, not global', async () => {
    const h = harness()
    h.fail('challenger')
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
    expect(document.body.querySelectorAll('[data-endeavour-section]')).toHaveLength(2)
    expect(view.right.querySelector('[data-outer-fallback]')).toBeNull()
  })

  it('keeps the trigger, marker and retry recovery while showing the detail', async () => {
    const h = harness()
    const view = await openBroken(h)
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
    expect(detailText()).toContain('endeavour.available:')
    const retry = document.body.querySelector('[data-endeavour-menu-retry]') as HTMLElement
    h.repairRole('endeavour')
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve() })
    expect(newest('[data-endeavour-menu-error]')).toBeNull()
    expect(newest('[data-endeavour-unified-pane]')).not.toBeNull()
    expect(triggers(view.right)).toBe(1)
    expect(marker(view.card)).toBe(view.seat)
    view.dispose()
  })
})

describe('post-commit role lifecycle', () => {
  it('performs no role call when the menu re-renders for other reasons', async () => {
    const h = harness()
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    const reads = (): number => h.spies.endeavour.reads + h.spies.challenger.reads
    const afterOpen = reads()
    expect(afterOpen).toBeGreaterThan(0)
    // Unrelated re-renders: keyboard navigation, a parent-style re-render, and a
    // catalog retry click. None of them may probe a role again.
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' })) })
    view.remount()
    expect(reads()).toBe(afterOpen)
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
  })

  it('survives a synchronous subscription callback', async () => {
    const h = harness()
    h.syncNotify = true
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(newest('[data-endeavour-menu-error]')).toBeNull()
    expect(newest('[data-endeavour-unified-pane]')).not.toBeNull()
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model One', 'Low', 'Model One', 'Low'])
  })

  it('settles a storm of identical notifications without boundary fallback', async () => {
    const h = harness()
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    const readsBefore = h.spies.challenger.reads
    await act(async () => {
      for (let i = 0; i < 200; i += 1) h.setSelection('challenger', { provider: 'p1', model: 'm1', reasoningEffort: 'low' })
      await Promise.resolve()
    })
    expect(newest('[data-endeavour-menu-error]')).toBeNull()
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model One', 'Low', 'Model One', 'Low'])
    // One read per notification, no amplification.
    expect(h.spies.challenger.reads - readsBefore).toBe(200)
    expect(triggers(view.right)).toBe(1)
  })

  it('propagates a changed selection for one role only', async () => {
    const h = harness()
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    await act(async () => {
      h.setSelection('challenger', { provider: 'p1', model: 'm2', reasoningEffort: 'high' })
      await Promise.resolve()
      await Promise.resolve()
    })
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    // Only the Challenger cells change; the Endeavour cells keep their values.
    // Model Two declares no thinking options, so that cell reads Not available.
    expect(values, JSON.stringify(values)).toEqual(['Model One', 'Low', 'Model Two', 'Not available'])
    expect(h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('reuses state for semantically identical selections', () => {
    const base = { provider: 'p', model: 'm', reasoningEffort: 'low' }
    expect(sameSelection(base, { ...base })).toBe(true)
    expect(sameSelection(base, { ...base, reasoningEffort: 'high' })).toBe(false)
    expect(sameSelection(base, { ...base, model: 'other' })).toBe(false)
    expect(sameSelection(base, { ...base, provider: 'other' })).toBe(false)
    expect(sameSelection(undefined, undefined)).toBe(true)
    expect(sameSelection(base, undefined)).toBe(false)
  })
})

describe('transactional menu setup', () => {
  const listeners = (h: Harness): number => h.spies.endeavour.listeners.size + h.spies.challenger.listeners.size

  it('disposes the successful first subscription when a later role setup fails', async () => {
    const h = harness()
    const view = slot(h)
    // Endeavour sets up first and subscribes; the Challenger subscribe then
    // throws, so the effect must unwind what it already created.
    h.breakOperation('challenger', 'subscribeSelection')
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(detailText()).toContain('challenger.subscribeSelection:')
    // RED today: the effect returned no cleanup, so the Endeavour listener is
    // still registered after the failure and after the menu unmounts.
    expect(h.spies.endeavour.listeners.size, 'endeavour listeners after failed setup').toBe(0)
    expect(listeners(h), 'total listeners after failed setup').toBe(0)
    expect(h.spies.endeavour.disposals, 'endeavour disposals').toBe(1)
    view.dispose()
    expect(listeners(h), 'total listeners after unmount').toBe(0)
    expect(h.spies.endeavour.disposals, 'endeavour disposals after unmount').toBe(1)
  })

  it('disposes exactly once when the setup reruns (retry) instead of unmounting', async () => {
    const h = harness()
    const view = slot(h)
    const retryRow = (): HTMLElement | null => menu()?.querySelector('[data-endeavour-retry="challenger"]') as HTMLElement | null
    const state = { e: () => h.spies.endeavour.listeners.size, c: () => h.spies.challenger.listeners.size, ed: () => h.spies.endeavour.disposals, cd: () => h.spies.challenger.disposals }

    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([1, 1, 0, 0])

    // Closing the menu tears the live subscriptions down exactly once.
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve() })
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([0, 0, 1, 1])

    // The Challenger directory goes away: reopening re-probes, so only the
    // Endeavour role subscribes again and the Challenger offers a retry row.
    h.breakChallenger()
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([1, 0, 1, 1])
    expect(retryRow()).not.toBeNull()

    // Retry reruns the effect: the previous run's subscription is disposed once
    // more and only the still-available role re-subscribes.
    await act(async () => { retryRow()?.click(); await Promise.resolve(); await Promise.resolve() })
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([1, 0, 2, 1])

    // Repair, retry: the Challenger is back and subscribes again. Disposals stay
    // exactly one per disposed subscription (created minus still live).
    h.repairChallenger()
    await act(async () => { retryRow()?.click(); await Promise.resolve(); await Promise.resolve() })
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([1, 1, 3, 1])

    // Unmount disposes the live set once, never twice.
    view.dispose()
    expect([state.e(), state.c(), state.ed(), state.cd()]).toEqual([0, 0, 4, 2])
  })

  it('disposes exactly once on a normal unmount', async () => {
    const h = harness()
    const view = slot(h)
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(listeners(h)).toBe(2)
    view.dispose()
    expect(listeners(h)).toBe(0)
    expect(h.spies.endeavour.disposals).toBe(1)
    expect(h.spies.challenger.disposals).toBe(1)
  })

  it('preserves the tagged setup error even when a disposer throws', async () => {
    const h = harness()
    const view = slot(h)
    h.breakOperation('challenger', 'subscribeSelection')
    h.breakDisposer('endeavour')
    await act(async () => { trigger(view.right)?.click(); await Promise.resolve(); await Promise.resolve() })
    expect(detailText()).toContain('challenger.subscribeSelection:')
    expect(detailText()).not.toContain('disposer exploded')
    expect(h.spies.endeavour.listeners.size).toBe(0)
    view.dispose()
  })
})
})

describe('shell purity', () => {
  it('keeps role calls out of initializers, memos and the rendered JSX', () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    const menu = source.slice(source.indexOf('function UnifiedMenu'), source.indexOf('function catalogKindKey'))
    // No useState initializer touches a role controller.
    const initializers = [...menu.matchAll(/useState[\s\S]{0,200}?\]\)|useState<[^>]*>\([\s\S]{0,200}?\)/g)].map((match) => match[0])
    expect(initializers.filter((text) => text.includes('roles['))).toHaveLength(0)
    // No useMemo body touches a role controller.
    const memos = menu.slice(menu.indexOf('const rows: readonly MenuRow[] = useMemo'), menu.indexOf('/** Retry re-probes'))
    expect(memos).not.toContain('roles[')
    // The rendered JSX never touches a role controller.
    const jsx = menu.slice(menu.indexOf('const paneRole: UnifiedRole | undefined'))
    expect(jsx).not.toContain('roles[')
    // The render preamble (destructure plus declarations) is role-free too.
    const preamble = menu.slice(0, menu.indexOf('const loadCatalog'))
    expect(preamble).not.toContain('roles[')
    // Every remaining role call sits in the catalog callback, an effect, a
    // subscription callback or an event handler — never in the render path.
    const calls = [...menu.matchAll(/roles\[[^\]]+\]\.\w+/g)].map((match) => match[0])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => /roles\[target\]\.(loadCatalog|available|readSelection|subscribeSelection|select)/.test(call))).toBe(true)
  })

  it('keeps every role controller operation below the menu boundary', () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    const shell = source.slice(
      source.indexOf('export function UnifiedModelControl'),
      source.indexOf('interface MenuBoundaryProps'),
    )
    // The stable shell only decides admission and owns the trigger.
    expect(shell).not.toMatch(/roles\s*[.\[]/)
    expect(shell).not.toContain('directoryFor')
    expect(shell).not.toContain('loadCatalog')
    expect(shell).not.toContain('subscribeSelection')
    // The fallible work lives in the menu subtree, inside the boundary.
    const menu = source.slice(source.indexOf('function UnifiedMenu'), source.indexOf('function catalogKindKey'))
    expect(menu).toContain('roles[target].loadCatalog()')
    expect(menu).toContain('subscribeSelection')
    expect(source.indexOf('<MenuBoundary')).toBeLessThan(source.indexOf('<UnifiedMenu'))
  })
})

describe('pure render: no role probing while rendering', () => {
  /**
   * Production composition the unit stubs miss: `directoryFor()` creates the
   * directory lazily, which can publish composer-block/session changes and
   * re-render the slot parent while UnifiedMenu is rendering. A render-time
   * probe therefore nests an update inside a render, and the unconditional
   * mirror in the availability effect turns that into React's
   * "Maximum update depth exceeded" (production invariant 185).
   */
  const LOOP_MESSAGE = 'Maximum update depth exceeded'

  /** Publication cap: without it the loop never settles and the runner hangs. */
  const PROBE_CAP = 30

  /** Slot whose parent re-renders (fresh props) on every role probe. */
  function liveSlot(): { readonly card: HTMLElement; readonly right: HTMLElement; readonly h: Harness; readonly probes: () => number } {
    const container = document.createElement('div')
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const right = document.createElement('div')
    right.setAttribute('data-slot', 'conversation.input.right')
    card.append(right)
    container.appendChild(card)
    document.body.appendChild(container)
    containers.push(container)

    let parentTick: (() => void) | undefined
    let probes = 0
    const h = harness()
    // Production memoizes the per-session controller, so this object keeps its
    // identity across parent renders; only the projections change.
    const probe = (operation: 'readSelection' | 'available'): void => {
      probes += 1
      // A lazy directory probe publishes composer/session changes synchronously,
      // which is what re-renders the slot parent during the first open.
      if (probes <= PROBE_CAP) parentTick?.()
      void operation
    }
    const stableRoles = {
      endeavour: {
        ...h.controller.roles.endeavour,
        readSelection: () => { probe('readSelection'); return h.controller.roles.endeavour.readSelection() },
        available: () => { probe('available'); return h.controller.roles.endeavour.available() },
      },
      challenger: h.controller.roles.challenger,
    }

    function Parent(): ReactNode {
      // Re-created on every parent render, exactly like a fresh bridge object:
      // the menu must not depend on this identity for its mirroring effect.
      const [, setTick] = useState<number>(0)
      parentTick = () => { setTick((value: number) => value + 1) }
      return createElement(UnifiedModelControl, {
        useProjection: (key: string) => {
          if (key === 'agentPreset') return 'endeavour'
          if (key === 'endeavourPeer') return pair()
          return null
        },
        sessionId: 'session-root',
        unifiedModels: { roles: stableRoles, admit: () => true },
        t: undefined,
      } as never)
    }

    const root = createRoot(right)
    roots.push(root)
    act(() => { root.render(createElement(Parent)) })
    return { card, right, h, probes: () => probes }
  }

  it('settles instead of looping when a role probe publishes a parent update', async () => {
    const view = liveSlot()
    const trigger = (): HTMLButtonElement | null => view.right.querySelector('[data-endeavour-unified-models]')
    // The open click mounts the menu, so the lazy probe runs inside its render.
    await act(async () => { trigger()?.click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    // RED today: every probe publishes another parent update, so the probes run
    // away until the cap and the menu never renders a pane.
    expect(view.probes()).toBeLessThanOrEqual(4)
    expect(newest('[data-endeavour-unified-pane]')).not.toBeNull()
    expect(newest('[data-endeavour-menu-error]')).toBeNull()
    expect(trigger()).not.toBeNull()
  })

  it('keeps the menu source free of render-time role calls', () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    // The selection snapshot is never seeded from a role controller in a
    // useState initializer.
    const initializer = source.slice(source.indexOf('useState<Record<UnifiedRole, UnifiedSelection'), source.indexOf('useState<Record<UnifiedRole, CatalogState>'))
    expect(initializer).not.toContain('readSelection')
    // Availability is never evaluated while rendering.
    expect(source).not.toContain('const availabilityKey = UNIFIED_ROLES.map')
    expect(source).not.toMatch(/const available = roleAvailable\(target\)/)
  })
})
