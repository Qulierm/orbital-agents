// @vitest-environment happy-dom
/**
 * Challenger peer model control: visibility (paired Endeavour root only), the
 * live peer mirror (read side), and official wrapped writes (write side with
 * model/effort preservation). No inherit/Automatic/next-child semantics.
 */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChallengerModelControl,
  type ChallengerModelController,
  type ChallengerSelection,
} from '../src/client/ChallengerModelControl.js'
import { challengerSessionIdFor, peerPairIdFor, type PeerState } from '../src/peer.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

const catalog: ModelCatalog = {
  default: { provider: 'p1', model: 'm1' },
  routableProviders: ['p1'],
  groups: [{ id: 'p1', name: 'Provider One', models: [
    { id: 'm1', name: 'Model One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
    { id: 'm2', name: 'Model Two' },
  ] }],
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

interface View {
  container: HTMLElement
  calls: { provider: string; model: string; effort: string | undefined }[]
  fail?: boolean
}

function props(options: {
  preset?: string | undefined
  peer?: unknown
  selection?: ChallengerSelection | undefined
  fail?: boolean
  challengerId?: string | undefined
  noChallenger?: boolean
  sessionId?: string
}): { props: Record<string, unknown>; calls: View['calls'] } {
  const calls: View['calls'] = []
  const selection = 'selection' in options ? options.selection : { provider: 'p1', model: 'm1', reasoningEffort: 'low' }
  const controller: ChallengerModelController = {
    challengerId: () => (options.noChallenger === true ? undefined : (options.challengerId ?? 'session-challenger')),
    readSelection: () => selection,
    subscribeSelection: () => () => undefined,
    loadCatalog: async () => catalog,
    select: async (provider, model, effort) => {
      calls.push({ provider, model, effort })
      if (options.fail === true) throw new Error('selection rejected')
    },
  }
  return {
    calls,
    props: {
      useProjection: (key: string) => {
        if (key === 'agentPreset') return options.preset ?? 'endeavour'
        if (key === 'endeavourPeer') return 'peer' in options ? options.peer : pair()
        return null
      },
      sessionId: options.sessionId ?? 'session-root',
      challengerModel: controller,
      t: undefined,
    } as never,
  }
}

function render(options: Parameters<typeof props>[0]): View {
  const { props: seat, calls } = props(options)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(ChallengerModelControl, seat as never)) })
  roots.push(root)
  containers.push(container)
  return { container, calls, ...(options.fail === true ? { fail: true } : {}) }
}

const chip = (container: HTMLElement) => container.querySelector('[data-endeavour-challenger-model]') as HTMLButtonElement | null
const menu = (): HTMLElement | null => document.body.querySelector('[data-endeavour-challenger-pane]')
const menuRows = (): HTMLElement[] => [...(menu()?.querySelectorAll('[role="menuitem"],[role="menuitemradio"]') ?? [])] as HTMLElement[]

/** Flush the catalog load plus a click in one act pass. */
async function settle(container: HTMLElement): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await act(async () => { chip(container)?.click(); await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

describe('visibility', () => {
  it('renders only for a paired Endeavour root with a resolved Challenger', () => {
    const view = render({})
    expect(chip(view.container)).not.toBeNull()
    expect(view.container.textContent).toContain('Challenger')
    // Before the catalog resolves the RAW id is shown; the pretty name arrives
    // with the live catalog (asserted in the read-side test below).
    expect(render({ preset: 'standard' }).container.textContent).toBe('')
    // The paired CHALLENGER side is hidden by its peer role alone.
    expect(render({ peer: pair(), sessionId: pair().challengerSessionId }).container.textContent).toBe('')
    expect(render({ peer: null }).container.textContent).toBe('')
    expect(render({ peer: { ...pair(), challengerSessionId: 'forged' } }).container.textContent).toBe('')
    expect(render({ noChallenger: true }).container.textContent).toBe('')
  })

  it('reports a peer without any stored selection honestly', () => {
    const view = render({ selection: undefined })
    expect(view.container.textContent).toContain('Challenger')
    expect(view.container.textContent).toContain('Not set')
    expect(view.container.textContent).not.toMatch(/inherit|automatic/i)
  })

  it('renders no inherit/Automatic/next-child wording anywhere', () => {
    const view = render({})
    const html = renderToStaticMarkup(createElement(ChallengerModelControl, props({}).props as never))
    expect(html).not.toMatch(/Inherit|Automatic|next child|Planner route/i)
    expect(view.container.textContent).not.toMatch(/Inherit|Automatic/i)
  })
})

describe('peer bridge wiring', () => {
  it('writes through official remote.session.selectModel for the CHALLENGER session only', async () => {
    vi.resetModules()
    const calls: unknown[] = []
    const pairState = pair()
    const face = (value: unknown) => {
      const listeners = new Set<() => void>()
      return { getSnapshot: () => value, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } } }
    }
    const faces = new Map<string, unknown>([
      ['session-root:endeavourPeer', face(pairState)],
      [`${pairState.challengerSessionId}:modelSelection`, face({ next: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } })],
    ])
    const registrations: { options: Record<string, unknown>; component: unknown }[] = []
    const fakeClient = {
      effect: () => undefined,
      locale: { register: () => undefined },
      uiConversation: { events: { register: () => undefined } },
      remote: { session: { selectModel: async (request: unknown) => { calls.push(request) }, modelCatalog: async () => catalog } },
      sessions: {
        binding: (id: string) => ({ session: { projections: { faceOf: (key: string) => faces.get(`${id}:${key}`) } } }),
      },
      slots: {
        inject: (_key: string, callback: () => unknown) => { callback() },
        register: (options: unknown, component: unknown) => {
          registrations.push({ options: options as Record<string, unknown>, component })
          return () => undefined
        },
      },
    }
    const { apply } = await import('../src/client/index.js')
    apply(fakeClient as never)
    const entry = registrations.find((item) => item.options.id === 'endeavour-challenger-model')
    expect(entry).toBeDefined()
    const injected = (entry?.options.inject as (sessionId: string) => { challengerModel: ChallengerModelController })('session-root')
    const controller = injected.challengerModel
    expect(controller.challengerId()).toBe(pairState.challengerSessionId)
    expect(controller.readSelection()).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
    await controller.select('p1', 'm2', 'high')
    await controller.select('p1', 'm2', undefined)
    expect(calls).toEqual([
      { sessionId: pairState.challengerSessionId, provider: 'p1', model: 'm2', reasoningEffort: 'high' },
      { sessionId: pairState.challengerSessionId, provider: 'p1', model: 'm2' },
    ])
    // The Endeavour session itself is never the target of a selection write.
    expect(calls.every((call) => (call as { sessionId: string }).sessionId !== 'session-root')).toBe(true)
  })
})

describe('read side', () => {
  it('shows the actual peer model and effort from the projection', async () => {
    const view = render({})
    await settle(view.container)
    const rootPane = menu()
    expect(rootPane?.textContent).toContain('Model One')
    expect(rootPane?.textContent).toContain('Low')
    expect(chip(view.container)?.textContent).toContain('Model One')
  })

  it('keeps a 40-model catalog from burying the effort cell and wraps keyboard focus', async () => {
    const big: ModelCatalog = {
      ...catalog,
      groups: [{ id: 'p1', name: 'Provider One', models: [
        catalog.groups[0]!.models[0]!,
        ...Array.from({ length: 39 }, (_, index) => ({ id: `f${index}`, name: `Filler ${index}` })),
      ] }],
    }
    const built = props({})
    const seat = {
      ...built.props,
      challengerModel: { ...(built.props.challengerModel as ChallengerModelController), loadCatalog: async () => big },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(createElement(ChallengerModelControl, seat as never)) })
    roots.push(root)
    containers.push(container)
    await settle(container)
    expect(menuRows()).toHaveLength(2)
    await act(async () => {
      menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.body.querySelector('[class*="menu-cell--active"]')?.textContent).toContain('Effort')
    await act(async () => {
      menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(menu()?.getAttribute('data-endeavour-challenger-pane')).toBe('effort')
    await act(async () => {
      menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(menu()?.getAttribute('data-endeavour-challenger-pane')).toBe('root')
  })
})

describe('write side', () => {
  it('writes the peer provider/model plus its declared default effort', async () => {
    const view = render({})
    await settle(view.container)
    const modelCell = menuRows().find((row) => row.getAttribute('role') === 'menuitem' && row.textContent?.includes('Model'))
    await act(async () => { (modelCell as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent?.includes('Model Two'))
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    expect(view.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
  })

  it('writes an effort while preserving the peer provider and model', async () => {
    const view = render({ selection: { provider: 'p1', model: 'm1', reasoningEffort: 'low' } })
    await settle(view.container)
    const effortCell = menuRows().find((row) => row.getAttribute('role') === 'menuitem' && row.textContent?.includes('Effort'))
    await act(async () => { (effortCell as HTMLElement).click() })
    const high = menuRows().find((row) => row.textContent?.trim() === 'High')
    await act(async () => { (high as HTMLElement).click(); await Promise.resolve() })
    expect(view.calls).toEqual([{ provider: 'p1', model: 'm1', effort: 'high' }])
  })

  it('surfaces a rejected selection without changing the mirror', async () => {
    const view = render({ fail: true })
    await settle(view.container)
    const modelCell = menuRows().find((row) => row.getAttribute('role') === 'menuitem' && row.textContent?.includes('Model'))
    await act(async () => { (modelCell as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent?.includes('Model Two'))
    await act(async () => { (option as HTMLElement).click(); await Promise.resolve() })
    expect(view.calls).toHaveLength(1)
    expect(chip(view.container)?.textContent).toContain('Model One')
  })
})
