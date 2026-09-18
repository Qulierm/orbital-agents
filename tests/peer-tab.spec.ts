// @vitest-environment happy-dom
/**
 * Peer navigation tabs: visibility from the `endeavourPeer` projection, role
 * labels, exact ISessions.open navigation, trusted-activation gating and
 * live update when the pair arrives or disappears. No subagent concepts.
 */

import { StrictMode, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openPeerTab,
  PeerTabView,
  peerTabTarget,
  reconcilePeerTab,
  registerPeerTabEntry,
  type PeerProjectionFace,
} from '../src/client/peer-tab.js'
import { challengerSessionIdFor, peerPairIdFor, type PeerState } from '../src/peer.js'

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
})

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

function face(value: unknown): PeerProjectionFace & { emit: () => void; set: (next: unknown) => void } {
  let current = value
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit: () => { for (const listener of [...listeners]) listener() },
    set: (next) => { current = next; for (const listener of [...listeners]) listener() },
  }
}

describe('peer tab target', () => {
  it('maps each role to its counterpart and rejects unpaired/corrupt states', () => {
    const state = pair()
    expect(peerTabTarget('session-root', state)).toEqual({ role: 'endeavour', counterpartId: state.challengerSessionId })
    expect(peerTabTarget(state.challengerSessionId, state)).toEqual({ role: 'challenger', counterpartId: 'session-root' })
    expect(peerTabTarget('session-other', state)).toBeUndefined()
    expect(peerTabTarget('session-root', null)).toBeUndefined()
    expect(peerTabTarget('session-root', { ...state, challengerSessionId: 'forged' })).toBeUndefined()
    expect(peerTabTarget(undefined, state)).toBeUndefined()
  })

  it('resets Chat before opening the exact counterpart and never opens on replay', () => {
    const state = pair()
    const calls: string[] = []
    const nav = {
      resetChat: (id: string) => { calls.push(`chat:${id}`) },
      peer: state,
      openCounterpart: (id: string) => { calls.push(`open:${id}`) },
      transientActivation: true,
    }
    expect(openPeerTab('session-root', nav)).toBe(true)
    expect(calls).toEqual(['chat:session-root', `open:${state.challengerSessionId}`])
    calls.length = 0
    expect(openPeerTab(state.challengerSessionId, nav)).toBe(true)
    expect(calls).toEqual([`chat:${state.challengerSessionId}`, 'open:session-root'])
    calls.length = 0
    expect(openPeerTab('session-root', { ...nav, transientActivation: false })).toBe(false)
    expect(calls).toEqual(['chat:session-root'])
    calls.length = 0
    expect(openPeerTab('session-root', { ...nav, peer: null })).toBe(false)
    expect(calls).toEqual(['chat:session-root'])
  })
})

describe('registration', () => {
  it('registers one role entry, switches role, and unregisters on unpairing', () => {
    const a = pair()
    const b = pair('session-root-b')
    let current = 'session-root'
    const currentListeners = new Set<() => void>()
    const faces = new Map<string, ReturnType<typeof face>>([
      ['session-root', face(a)],
      ['session-root-b', face(b)],
    ])
    const registrations: string[] = []
    let disposed = 0
    const dispose = reconcilePeerTab({
      currentSession: () => current,
      subscribeCurrent: (listener) => { currentListeners.add(listener); return () => { currentListeners.delete(listener) } },
      peerFace: (sessionId, key) => (key === 'endeavourPeer' ? faces.get(sessionId) : undefined),
      register: (role) => { registrations.push(role); return () => { disposed += 1 } },
    })
    expect(registrations).toEqual(['endeavour'])
    // The same session switching to the challenger role switches the entry.
    current = a.challengerSessionId
    faces.set(a.challengerSessionId, face(a))
    for (const listener of [...currentListeners]) listener()
    expect(registrations).toEqual(['endeavour', 'challenger'])
    expect(disposed).toBe(1)
    // A session without a valid pair unregisters the tab.
    current = 'session-other'
    for (const listener of [...currentListeners]) listener()
    expect(disposed).toBe(2)
    // Live projection change to an invalid state also unregisters.
    current = 'session-root'
    for (const listener of [...currentListeners]) listener()
    expect(registrations.at(-1)).toBe('endeavour')
    faces.get('session-root')!.set({ ...a, challengerSessionId: 'forged' })
    expect(disposed).toBe(3)
    dispose()
    expect(disposed).toBe(3)
  })

  it('registers the official entry options per role', () => {
    const entries: { options: Record<string, unknown> }[] = []
    const slots = { inject: () => undefined, register: (options: unknown) => { entries.push({ options: options as Record<string, unknown> }); return () => undefined } }
    registerPeerTabEntry(slots, 'endeavour', () => true)
    registerPeerTabEntry(slots, 'challenger', () => true)
    expect(entries[0]?.options.id).toBe('endeavour-challenger-tab')
    expect((entries[0]?.options.label as () => string)()).toBe('Challenger')
    expect(entries[1]?.options.id).toBe('endeavour-endtab')
    expect((entries[1]?.options.label as () => string)()).toBe('Endeavour')
    expect(entries[0]?.options.order).toBe(20)
    expect(entries[0]?.options.name).toBe('conversation.view')
  })

  it('is navigation only and selects exactly once under StrictMode', () => {
    const calls: number[] = []
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(StrictMode, null, createElement(PeerTabView, {
        peerTab: { select: () => { calls.push(1); return true } },
        t: undefined,
      } as never)))
    })
    roots.push(root)
    containers.push(container)
    expect(calls).toHaveLength(1)
    expect(container.textContent).toBe('')
  })
})
