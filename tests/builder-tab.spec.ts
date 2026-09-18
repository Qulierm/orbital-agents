// @vitest-environment happy-dom
/**
 * Builder navigation tab regressions: conditional target validity, dynamic
 * idempotent registration, safe navigation order, and StrictMode/one-shot
 * mount behavior.
 */

import { StrictMode, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addressedContinuableChild,
  BuilderTabView,
  builderTabTarget,
  endeavourTabTarget,
  openEndeavourTab,
  openBuilderTab,
  reconcileBuilderTab,
  registerBuilderTabEntry,
  type ProjectionFace,
} from '../src/client/builder-tab.js'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

function face(value: unknown): ProjectionFace & { emit: () => void } {
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit: () => { for (const listener of [...listeners]) listener() },
  }
}

describe('builderTabTarget', () => {
  const plan = { rootSessionId: 'root', childId: 'child' }

  it('accepts only an Endeavour root pointing at its own non-empty child', () => {
    expect(builderTabTarget('root', 'endeavour', plan)).toEqual({ parentSessionId: 'root', childSessionId: 'child' })
    expect(builderTabTarget('root', 'endeavour', { ...plan, terminal: true })).toEqual({ parentSessionId: 'root', childSessionId: 'child' })
  })

  it('rejects standard chats, children, blank roots, and corrupt projections', () => {
    expect(builderTabTarget('root', 'standard', plan)).toBeUndefined()
    expect(builderTabTarget('root', undefined, plan)).toBeUndefined()
    expect(builderTabTarget('child', 'endeavour', { rootSessionId: 'root', childId: 'child' })).toBeUndefined()
    expect(builderTabTarget('root', 'endeavour', undefined)).toBeUndefined()
    expect(builderTabTarget('root', 'endeavour', null)).toBeUndefined()
    expect(builderTabTarget('root', 'endeavour', { rootSessionId: 'root' })).toBeUndefined()
    expect(builderTabTarget('root', 'endeavour', { rootSessionId: 'other', childId: 'child' })).toBeUndefined()
    expect(builderTabTarget('root', 'endeavour', { rootSessionId: 'root', childId: '' })).toBeUndefined()
    expect(builderTabTarget(undefined, 'endeavour', plan)).toBeUndefined()
  })
})

describe('reconcileBuilderTab', () => {
  function harness(initialSession: string | undefined) {
    const registrations: string[] = []
    let disposed = 0
    let current = initialSession
    const currentListeners = new Set<() => void>()
    const sessionFaces = {
      root: { agentPreset: face('endeavour'), endeavourPlan: face({ rootSessionId: 'root', childId: 'child' }) },
      standard: { agentPreset: face('standard'), endeavourPlan: face(undefined) },
      child: { agentPreset: face('endeavour'), endeavourPlan: face({ rootSessionId: 'root', childId: 'child' }) },
    }
    const dispose = reconcileBuilderTab({
      currentSession: () => current,
      subscribeCurrent: (listener) => { currentListeners.add(listener); return () => { currentListeners.delete(listener) } },
      face: (sessionId, key) => (sessionFaces as Record<string, Record<string, ProjectionFace>>)[sessionId]?.[key],
      subagent: () => undefined,
      register: () => {
        registrations.push(current ?? 'none')
        return () => { disposed += 1 }
      },
    })
    return {
      dispose,
      registrations,
      disposedCount: () => disposed,
      switchTo: (sessionId: string | undefined) => {
        current = sessionId
        for (const listener of [...currentListeners]) listener()
      },
      faceOf: (sessionId: string, key: string) => (sessionFaces as Record<string, Record<string, ReturnType<typeof face>>>)[sessionId]?.[key],
    }
  }

  it('registers once for a valid root and never duplicates on repeated notifications', () => {
    const view = harness('root')
    expect(view.registrations).toEqual(['root'])
    view.faceOf('root', 'endeavourPlan')!.emit()
    view.faceOf('root', 'agentPreset')!.emit()
    expect(view.registrations).toEqual(['root'])
    expect(view.disposedCount()).toBe(0)
  })

  it('unregisters on a Standard session and re-registers for a valid root', () => {
    const view = harness('root')
    view.switchTo('standard')
    expect(view.disposedCount()).toBe(1)
    view.switchTo('root')
    expect(view.registrations).toEqual(['root', 'root'])
    view.switchTo('child')
    expect(view.disposedCount()).toBe(2)
    view.dispose()
    expect(view.disposedCount()).toBe(2)
  })

  it('reconciles when the projection arrives later or turns terminally invalid', () => {
    const plan = face(undefined)
    const registrations: number[] = []
    let disposed = 0
    const dispose = reconcileBuilderTab({
      currentSession: () => 'root',
      subscribeCurrent: () => () => undefined,
      face: (sessionId, key) => key === 'agentPreset' ? face('endeavour') : plan,
      subagent: () => undefined,
      register: () => { registrations.push(1); return () => { disposed += 1 } },
    })
    expect(registrations).toHaveLength(0)
    plan.emit() // still undefined
    expect(registrations).toHaveLength(0)
    // A later session switch re-reads; simulate arrival by re-subscribing path:
    dispose()
    const plan2 = face({ rootSessionId: 'root', childId: 'child-2' })
    const dispose2 = reconcileBuilderTab({
      currentSession: () => 'root',
      subscribeCurrent: () => () => undefined,
      face: (sessionId, key) => key === 'agentPreset' ? face('endeavour') : plan2,
      subagent: () => undefined,
      register: () => { registrations.push(1); return () => { disposed += 1 } },
    })
    expect(registrations).toHaveLength(1)
    dispose2()
    expect(disposed).toBe(1)
  })
})

describe('openBuilderTab', () => {
  it('resets Chat before opening the exact child exactly once on a real click', () => {
    const calls: string[] = []
    const opened: unknown[] = []
    const result = openBuilderTab('root', {
      resetChat: (sessionId) => { calls.push(`chat:${sessionId}`) },
      readPlan: () => { calls.push('plan'); return { rootSessionId: 'root', childId: 'child' } },
      open: (address) => { calls.push('open'); opened.push(address) },
      transientActivation: true,
    })
    expect(result).toBe(true)
    expect(calls).toEqual(['chat:root', 'plan', 'open'])
    expect(opened).toEqual([{ parentSessionId: 'root', childSessionId: 'child' }])
  })

  it('resets Chat but never auto-opens on a replay/restore mount', () => {
    const calls: string[] = []
    const result = openBuilderTab('root', {
      resetChat: () => { calls.push('chat') },
      readPlan: () => { calls.push('plan'); return { rootSessionId: 'root', childId: 'child' } },
      open: () => { calls.push('open') },
      transientActivation: false,
    })
    expect(result).toBe(false)
    expect(calls).toEqual(['chat'])
  })

  it('resets Chat and fails safely when the child vanished or the projection is corrupt', () => {
    for (const plan of [undefined, null, { rootSessionId: 'root' }, { rootSessionId: 'other', childId: 'child' }, { rootSessionId: 'root', childId: '' }]) {
      const calls: string[] = []
      const result = openBuilderTab('root', {
        resetChat: () => { calls.push('chat') },
        readPlan: () => plan,
        open: () => { calls.push('open') },
        transientActivation: true,
      })
      expect(result).toBe(false)
      expect(calls).toEqual(['chat'])
    }
  })

  it('does nothing without a session', () => {
    const calls: string[] = []
    expect(openBuilderTab(undefined, {
      resetChat: () => { calls.push('chat') },
      readPlan: () => ({ rootSessionId: 'root', childId: 'child' }),
      open: () => { calls.push('open') },
      transientActivation: true,
    })).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('registerBuilderTabEntry', () => {
  it('registers one idempotent conversation.view entry with the official options', () => {
    const entries: { options: Record<string, unknown>; component: unknown }[] = []
    let unregistered = 0
    const slots = {
      inject: () => undefined,
      register: (options: unknown, component: unknown) => {
        entries.push({ options: options as Record<string, unknown>, component })
        return () => { unregistered += 1 }
      },
    }
    const dispose = registerBuilderTabEntry(slots, 'builder', (sessionId, openView) => {
      if (sessionId !== 'root') return false
      openView?.('chat', '')
      return true
    })
    expect(entries).toHaveLength(1)
    const options = entries[0]?.options ?? {}
    expect(options.name).toBe('conversation.view')
    expect(options.id).toBe('endeavour-builder')
    expect(options.order).toBe(20)
    expect(options.locale).toBe('endeavour')
    expect((options.label as () => string)()).toBe('Builder')
    const selectors: string[] = []
    const bridge = (options.inject as (sessionId: string) => { builderTab: { select: (openView?: (view: string, focus: string) => void) => boolean } })('root')
    expect(bridge.builderTab.select((view) => { selectors.push(view) })).toBe(true)
    expect(selectors).toEqual(['chat'])
    const other = (options.inject as (sessionId: string) => { builderTab: { select: (openView?: (view: string, focus: string) => void) => boolean } })('standard')
    expect(other.builderTab.select()).toBe(false)
    expect(entries[0]?.component).toBe(BuilderTabView)
    dispose()
    expect(unregistered).toBe(1)
  })
})

describe('reciprocal Endeavour tab', () => {
  const childAddress = { parentSessionId: 'root', childSessionId: 'child', mode: 'continuable' }

  it('accepts only the exact addressed continuable child', () => {
    expect(addressedContinuableChild('child', { address: childAddress })).toEqual({ parentSessionId: 'root', childSessionId: 'child' })
    expect(addressedContinuableChild('other', { address: childAddress })).toBeUndefined()
    expect(addressedContinuableChild('child', { address: { ...childAddress, mode: 'one-shot' } })).toBeUndefined()
    expect(addressedContinuableChild('child', {})).toBeUndefined()
    expect(addressedContinuableChild(undefined, { address: childAddress })).toBeUndefined()
  })

  it('requires the parent durable plan to point at exactly this child', () => {
    const parentPlan = { rootSessionId: 'root', childId: 'child' }
    expect(endeavourTabTarget('child', { address: childAddress }, 'endeavour', parentPlan)).toEqual({ parentSessionId: 'root', childSessionId: 'child' })
    expect(endeavourTabTarget('child', { address: childAddress }, 'endeavour', { rootSessionId: 'root', childId: 'other' })).toBeUndefined()
    expect(endeavourTabTarget('child', { address: childAddress }, 'standard', parentPlan)).toBeUndefined()
    expect(endeavourTabTarget('child', { address: childAddress }, 'endeavour', undefined)).toBeUndefined()
  })

  it('resets Chat before opening the parent, and never opens on replay mounts', () => {
    const calls: string[] = []
    const readerIds: string[] = []
    const nav = {
      resetChat: () => { calls.push('chat') },
      subagent: { address: childAddress },
      // Regression: the parent readers must receive the PARENT id, never the
      // child id, or the click silently no-ops in the deployed app.
      readParentPlan: (id: string) => { readerIds.push(id); return id === 'root' ? { rootSessionId: 'root', childId: 'child' } : undefined },
      readParentPreset: (id: string) => { readerIds.push(id); return id === 'root' ? 'endeavour' : undefined },
      openParent: (id: string) => { calls.push(`open:${id}`) },
      transientActivation: true,
    }
    expect(openEndeavourTab('child', nav)).toBe(true)
    expect(calls).toEqual(['chat', 'open:root'])
    expect(readerIds.every((id) => id === 'root')).toBe(true)
    calls.length = 0
    expect(openEndeavourTab('child', { ...nav, transientActivation: false })).toBe(false)
    expect(calls).toEqual(['chat'])
    calls.length = 0
    expect(openEndeavourTab('child', { ...nav, subagent: { address: { ...childAddress, mode: 'one-shot' } } })).toBe(false)
    expect(calls).toEqual(['chat'])
  })
})

describe('BuilderTabView', () => {
  it('is navigation only: renders nothing and selects exactly once under StrictMode', () => {
    const calls: number[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(StrictMode, null, createElement(BuilderTabView, {
        builderTab: { select: () => { calls.push(1); return true } },
        t: undefined,
      } as never)))
    })
    roots.push(root)
    containers.push(container)
    expect(calls).toHaveLength(1)
    expect(container.textContent).toBe('')
    // Re-render/remount does not navigate again unless the host mounts it anew.
    act(() => { root.render(createElement(StrictMode, null, createElement(BuilderTabView, { builderTab: { select: () => { calls.push(1); return true } }, t: undefined } as never))) })
    expect(calls).toHaveLength(1)
  })
})
