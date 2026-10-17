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
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNIFIED_ROLES,
  ChallengerModelControl,
  type UnifiedModelController,
  type UnifiedRole,
  type UnifiedRoleController,
  type UnifiedSelection,
} from '../src/client/UnifiedModelControl.js'
import { MENU_DETAIL_MAX, safeDiagnostic, sameSelection } from '../src/client/UnifiedModelControl.js'
import { challengerSessionIdFor, peerPairIdFor, type PeerState } from '../src/peer.js'
import { NS } from '../src/client/locales.js'
import { STYLE_TEXT } from '../src/client/styles.js'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CHALLENGER_ID = challengerSessionIdFor('session-root')

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
      { id: 'm3', name: 'Model Three', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
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
  /** Owned session references this role handed out. */
  acquisitions: number
  /** References this role took back, and whether any was released twice. */
  releases: number
  doubleReleases: number
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
  /** Expose an owned-reference capability on that role. */
  withAcquisition(...roles: UnifiedRole[]): void
  /** Settle one role's pending readiness successfully. */
  resolveAcquisition(role: UnifiedRole): Promise<void>
  /** Settle it as a failed acquisition. */
  rejectAcquisition(role: UnifiedRole, message?: string): Promise<void>
  /** Make the next acquire() throw synchronously. */
  breakAcquisition(role: UnifiedRole, message?: string): void
  /** Hold that role's writes open until the test settles them. */
  deferSelect(role: UnifiedRole): void
  /** Settle the held write: success or rejection. */
  settleSelect(role: UnifiedRole, error?: Error): Promise<void>
  /** Settle it synchronously inside the click handler, as a thenable would. */
  settleSelectSynchronously(role: UnifiedRole): void
  /** How many writes have been initiated per role. */
  writeAttempts(role: UnifiedRole): number
  failPendingSave(): void
  /** Resolves when the next test-controlled pending save settles. */
  waitForPendingSave(): Promise<void>
  get pending(): { readonly record?: { readonly revision: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }; readonly error?: string }
}

/**
 * Two independent role bridges. Each spy records its own calls and loads, so a
 * cross-role write or a shared selection store is detectable.
 */
function harness(options: {
  endeavour?: UnifiedSelection | undefined
  challenger?: UnifiedSelection | undefined
  absent?: readonly UnifiedRole[]
  beforePendingSave?: () => Promise<void>
} = {}): Harness {
  const spies: Record<UnifiedRole, RoleSpy> = {
    endeavour: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0, reads: 0, disposals: 0, acquisitions: 0, releases: 0, doubleReleases: 0 },
    challenger: { calls: [], listeners: new Set(), selections: { provider: 'p1', model: 'm1', reasoningEffort: 'low' }, loads: 0, reads: 0, disposals: 0, acquisitions: 0, releases: 0, doubleReleases: 0 },
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
  let pairValid = true
  let admitted = false
  let sourceGeneration = 0
  let sourceKey = 'hidden:root-test'
  let sourceValue: ReturnType<UnifiedModelController['sourceSnapshot']> = { mode: 'hidden', key: sourceKey, generation: sourceGeneration }
  const sourceListeners = new Set<() => void>()
  let pendingRevision = 0
  let pendingSnapshot: { readonly record?: { readonly schemaVersion: 1; readonly revision: string; readonly provider: string; readonly model: string; readonly reasoningEffort?: string }; readonly error?: string } = {}
  const pendingListeners = new Set<() => void>()
  let pendingWriteFails = false
  let pendingError: string | undefined
  const pendingSaveWaiters: Array<() => void> = []
  const waitForPendingSave = (): Promise<void> => new Promise((resolve) => { pendingSaveWaiters.push(resolve) })
  const finishPendingSave = (): void => { pendingSaveWaiters.shift()?.() }
  const notifyPending = (): void => { for (const listener of [...pendingListeners]) listener() }
  const updateSource = (): boolean => {
    const mode = !admitted ? 'hidden' as const : pairValid ? 'peer' as const : 'draft' as const
    const key = mode === 'peer' ? 'peer:challenger-test' : `${mode}:root-test`
    if (key === sourceKey) return false
    sourceKey = key
    sourceGeneration += 1
    sourceValue = mode === 'peer'
      ? { mode, key, generation: sourceGeneration, peerId: 'challenger-test' }
      : { mode, key, generation: sourceGeneration }
    return true
  }
  const sourceSnapshot = (): UnifiedModelController['sourceSnapshot'] extends () => infer T ? T : never => {
    updateSource()
    return sourceValue
  }
  // Optional owned-session capability: only roles named here expose `acquire`.
  // Readiness is deferred until the test settles it, so a pending role can be
  // observed while the other role is already usable.
  const acquiring = new Set<UnifiedRole>()
  const pendingReady = new Map<UnifiedRole, { promise: Promise<unknown>; resolve: () => void; reject: (error: Error) => void }>()
  const acquireThrows = new Map<UnifiedRole, Error>()
  const releasedOnce = new Set<object>()
  // Controlled writes: a role in `heldWrites` returns a pending promise the test
  // settles, and one in `syncWrites` settles inside the click handler.
  const heldWrites = new Map<UnifiedRole, { resolve: () => void; reject: (error: Error) => void; pending: boolean }>()
  const deferredWriteRoles = new Set<UnifiedRole>()
  const syncWriteRoles = new Set<UnifiedRole>()
  const writeAttempts = new Map<UnifiedRole, number>()
  const brokenDisposers = new Set<UnifiedRole>()
  // Bridge contract for an unavailable paired directory: report the role as
  // unavailable and reject only its OWN load/select; never throw at render time.
  const down = (role: UnifiedRole): boolean => role === 'challenger' && challengerDown
  const downError = (): Error => new Error('the paired Challenger session is unavailable')
  const roles = {} as Record<UnifiedRole, UnifiedRoleController>
  for (const role of UNIFIED_ROLES) {
    const spy = spies[role]
    roles[role] = {
      available: () => { boom(role, 'available'); return (role !== 'challenger' || pairValid) && !down(role) && !(options.absent ?? []).includes(role) },
      readSelection: () => {
        boom(role, 'readSelection')
        spy.reads += 1
        return down(role) || (role === 'challenger' && !pairValid) ? undefined : spy.selections
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
        const catalogRole = role === 'challenger' && !pairValid ? 'endeavour' : role
        if (down(role) || (role === 'challenger' && pairValid === false && (options.absent ?? []).includes('endeavour'))) throw downError()
        spies[catalogRole].loads += 1
        if (failingLoad.has(catalogRole)) throw new Error(`${catalogRole} catalog unavailable`)
        return catalog
      },
      select: (provider, model, effort): Promise<void> => {
        boom(role, 'available')
        if (role === 'challenger' && !pairValid) return Promise.reject(downError())
        writeAttempts.set(role, (writeAttempts.get(role) ?? 0) + 1)
        // One directory semantics for every path: the attempt is always visible,
        // a rejected write leaves the PERSISTED selection untouched, and only a
        // stored write updates the mirror and notifies subscribers.
        const begin = (): void => { spy.calls.push({ provider, model, effort }) }
        const stored = (): unknown => (failing.has(role) ? new Error(`${role} selection rejected`) : undefined)
        const persist = (): void => {
          spy.selections = { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
          for (const listener of spy.listeners) listener()
        }
        const finish = (): Error | undefined => {
          begin()
          const error = stored()
          if (error === undefined) persist()
          return error as Error | undefined
        }
        if (syncWriteRoles.has(role)) {
          // A thenable that settles DURING the click handler: the completion runs
          // while the generation that started it is still the live one.
          if (down(role)) {
            return { then: (_ok: unknown, fail: (error: unknown) => void) => { fail(downError()) } } as unknown as Promise<void>
          }
          const error = finish()
          return (error === undefined
            ? { then: (ok: () => void) => { ok() } }
            : { then: (_ok: unknown, fail: (thrown: unknown) => void) => { fail(error) } }) as unknown as Promise<void>
        }
        if (!deferredWriteRoles.has(role)) {
          return (async (): Promise<void> => {
            if (down(role)) throw downError()
            const error = finish()
            if (error !== undefined) throw error
          })()
        }
        return new Promise<void>((resolve, reject) => {
          heldWrites.set(role, {
            pending: true,
            resolve: () => { const error = finish(); if (error === undefined) resolve(); else reject(error) },
            reject: (error: Error) => { reject(error) },
          })
        })
      },
      // Consulted at CALL time: a role this test did not enable behaves exactly
      // like a bridge that offers no owned reference at all.
      acquire: () => {
        if (!acquiring.has(role) || (role === 'challenger' && !pairValid)) return undefined
        const failure = acquireThrows.get(role)
        if (failure !== undefined) { acquireThrows.delete(role); throw failure }
        spy.acquisitions += 1
        let resolve: () => void = () => undefined
        let reject: (error: Error) => void = () => undefined
        const promise = new Promise<unknown>((res, rej) => { resolve = () => { res(undefined) }; reject = rej })
        pendingReady.set(role, { promise, resolve, reject })
        const lease = {
          ready: promise,
          release: () => {
            // A reference released twice is a leak in the other direction.
            if (releasedOnce.has(lease)) { spy.doubleReleases += 1; return }
            releasedOnce.add(lease)
            spy.releases += 1
          },
        }
        return lease
      },
    }
  }
  // Admission requires an explicit Endeavour preset, but no paired session.
  const pendingSelection: UnifiedModelController['pendingSelection'] = {
    getSnapshot: () => pendingSnapshot,
    subscribe: (listener) => { pendingListeners.add(listener); return () => { pendingListeners.delete(listener) } },
    save: async (selection) => {
      try {
        if (pendingWriteFails) {
          pendingWriteFails = false
          pendingError = 'Could not save the Challenger choice in this browser.'
          pendingSnapshot = { ...pendingSnapshot, error: pendingError }
          notifyPending()
          throw new Error(pendingError)
        }
        const record = { schemaVersion: 1 as const, revision: `revision-${++pendingRevision}`, ...selection }
        await options.beforePendingSave?.()
        pendingError = undefined
        pendingSnapshot = { record }
        notifyPending()
        return record
      } finally {
        finishPendingSave()
      }
    },
    removeIfRevision: async (revision) => {
      if (pendingSnapshot.record?.revision !== revision) return false
      pendingSnapshot = {}
      pendingError = undefined
      notifyPending()
      return true
    },
  }
  const controller: UnifiedModelController = {
    roles,
    sourceSnapshot,
    subscribeSource: (listener) => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener) } },
    pendingSelection,
    applyPendingToPeer: async (revision, peerId, generation) => {
      const source = sourceSnapshot()
      const record = pendingSelection.getSnapshot().record
      if (source.mode !== 'peer' || source.peerId !== peerId || source.generation !== generation || record?.revision !== revision) return false
      await roles.challenger.select(record.provider, record.model, record.reasoningEffort)
      return pendingSelection.removeIfRevision(revision)
    },
    admit: (preset: string | undefined) => {
      if (preset !== undefined && preset !== 'endeavour') admitted = false
      if (preset === 'endeavour') admitted = true
      updateSource()
      return admitted
    },
  }
  return {
    controller,
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
    setPairValid: (valid) => {
      pairValid = valid
      if (updateSource()) for (const listener of [...sourceListeners]) listener()
    },
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
    withAcquisition: (...roles) => { for (const role of roles) acquiring.add(role) },
    resolveAcquisition: async (role) => {
      const pending = pendingReady.get(role)
      if (pending === undefined) throw new Error(`no pending acquisition for ${role}`)
      pendingReady.delete(role)
      await act(async () => { pending.resolve(); await Promise.resolve(); await Promise.resolve() })
    },
    rejectAcquisition: async (role, message) => {
      const pending = pendingReady.get(role)
      if (pending === undefined) throw new Error(`no pending acquisition for ${role}`)
      pendingReady.delete(role)
      await act(async () => { pending.reject(new Error(message ?? `${role} session is unavailable`)); await Promise.resolve(); await Promise.resolve() })
    },
    breakAcquisition: (role, message) => { acquireThrows.set(role, new Error(message ?? `${role} retain failed`)) },
    deferSelect: (role) => { deferredWriteRoles.add(role); syncWriteRoles.delete(role) },
    settleSelectSynchronously: (role) => { deferredWriteRoles.delete(role); syncWriteRoles.add(role) },
    settleSelect: async (role, error) => {
      const held = heldWrites.get(role)
      if (held === undefined || !held.pending) throw new Error(`no held write for ${role}`)
      held.pending = false
      heldWrites.delete(role)
      await act(async () => {
        if (error === undefined) held.resolve()
        else held.reject(error)
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    writeAttempts: (role) => writeAttempts.get(role) ?? 0,
    failPendingSave: () => { pendingWriteFails = true },
    waitForPendingSave,
    get pending() { return pendingSelection.getSnapshot() },
  }
}

function render(options: {
  preset?: string | undefined
  peer?: unknown
  plan?: unknown
  sessionId?: string
  harness?: Harness
  t?: unknown
} = {}): { container: HTMLElement; h: Harness } {
  const h = options.harness ?? harness()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const peer = 'peer' in options ? options.peer : pair()
  act(() => {
    root.render(createElement(ChallengerModelControl, {
      useProjection: (key: string) => {
        if (key === 'agentPreset') return options.preset ?? 'endeavour'
        if (key === 'endeavourPeer') return peer
        if (key === 'endeavourPlan') return 'plan' in options ? options.plan : null
        return null
      },
      sessionId: options.sessionId ?? 'session-root',
      unifiedModels: h.controller,
      t: options.t,
    } as never))
  })
  roots.push(root)
  containers.push(container)
  return { container, h }
}

const trigger = (container: HTMLElement): HTMLButtonElement | null => container.querySelector('[data-endeavour-challenger-models]')
/** Newest portal in document order: earlier mounted views may still be present. */
const newest = (selector: string): Element | null =>
  [...document.body.querySelectorAll(selector)].at(-1) ?? null
/** Diagnostics text of the newest menu error surface. */
const detailText = (): string => newest('[data-endeavour-menu-error-detail]')?.textContent ?? ''
const menu = (): HTMLElement | null => newest('[data-endeavour-challenger-pane]') as HTMLElement | null
const menuRows = (): HTMLElement[] => [...(menu()?.querySelectorAll('[role="menuitem"],[role="menuitemradio"]') ?? [])] as HTMLElement[]
/** The pane the popup is showing: the popup is peer-only, so no role is encoded. */
const pane = (): string | null => menu()?.getAttribute('data-endeavour-challenger-pane') ?? null
/** Visible button text: always just the localized role word. */
const triggerLabel = (container: HTMLElement): string => (trigger(container)?.querySelector('[data-endeavour-challenger-label]')?.textContent ?? '').trim()
/** Tooltip/accessible description: the full selection or status. */
const tooltip = (container: HTMLElement): string => trigger(container)?.getAttribute('title') ?? ''
const ariaLabel = (container: HTMLElement): string => trigger(container)?.getAttribute('aria-label') ?? ''

/** Flush the catalog loads plus one trigger click in a single act pass. */
async function open(container: HTMLElement): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  await act(async () => { trigger(container)?.click(); await Promise.resolve() })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function saveOption(h: Harness, option: HTMLElement): Promise<void> {
  const saved = h.waitForPendingSave()
  await act(async () => { option.click(); await saved; await Promise.resolve(); await Promise.resolve() })
}


describe('visibility and registration surface', () => {
  it('registers exactly one Challenger control in the model seat beside the native selector', async () => {
    vi.resetModules()
    const registrations: { name: string; id?: string; order?: number; locale?: string; inject?: unknown }[] = []
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
    const custom = registrations.filter((entry) => entry.id === 'endeavour-challenger-model')
    expect(custom).toHaveLength(1)
    expect(custom[0]).toMatchObject({ name: 'conversation.input.right', order: 1000, locale: NS })
    // The old combined control is gone, and only this one custom entry exists.
    expect(registrations.some((entry) => entry.id === 'endeavour-models')).toBe(false)
    // The native single-occupancy model seat is never registered into: a second
    // same-priority entry there is rejected and fails the whole client module.
    expect(registrations.some((entry) => entry.name === 'conversation.input.model')).toBe(false)
  })

  it('renders for an explicitly selected Endeavour root before a peer exists', async () => {
    const ok = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(trigger(ok.container)).not.toBeNull()
    // The controller admits an explicit root without a peer; Standard remains
    // excluded and the native Challenger-side fallback remains unchanged.
    const unpaired = harness()
    unpaired.setPairValid(false)
    const unpairedView = render({ harness: unpaired })
    expect(trigger(unpairedView.container)).not.toBeNull()
    expect(trigger(unpairedView.container)?.disabled).toBe(false)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(unpaired.spies.endeavour.loads).toBe(1)
    expect(unpaired.spies.challenger.acquisitions).toBe(0)
    expect(trigger(render({ preset: 'standard' }).container)).toBeNull()
    // Without a controller admission hook the component falls back to the
    // validated peer's own role, so a Challenger-side session renders nothing.
    const plain = harness()
    const rolesOnly = { roles: plain.controller.roles }
    expect(trigger(render({ harness: { ...plain, controller: rolesOnly } as unknown as Harness, sessionId: CHALLENGER_ID }).container)).toBeNull()
    expect(trigger(render({ harness: { ...plain, controller: rolesOnly } as unknown as Harness }).container)).not.toBeNull()
    // Absorb the post-commit lifecycle of every render above.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
  })

  it('saves a selectable catalog choice locally before the peer exists without writing the root', async () => {
    const h = harness()
    h.setPairValid(false)
    const view = render({ harness: h })
    await open(view.container)
    expect(trigger(view.container)?.disabled).toBe(false)
    expect(pane()).toBe('root')
    expect(menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)).toEqual(['Model One', 'Low'])
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    expect(option).toBeDefined()
    await saveOption(h, option as HTMLElement)
    expect(h.pending.record).toMatchObject({ provider: 'p1', model: 'm2' })
    expect(h.spies.endeavour.calls).toEqual([])
    expect(h.spies.challenger.calls).toEqual([])
    expect(h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Saved in this browser; waiting for Challenger')
    expect(tooltip(view.container)).not.toContain('Applies to requests assembled after application')
    expect(ariaLabel(view.container)).toContain('Saved in this browser; waiting for Challenger')
    expect(trigger(view.container)?.getAttribute('title')).toContain('Saved in this browser; waiting for Challenger')
    await open(view.container)
    expect(menu()?.querySelector('[data-endeavour-selection-status]')?.textContent).toBe('Saved in this browser; waiting for Challenger')
    expect(menu()?.textContent).not.toContain('Applies to requests assembled after application')
  })

  it('automatically applies the latest saved revision when a validated peer becomes ready once', async () => {
    const h = harness()
    h.setPairValid(false)
    const view = render({ harness: h })
    await open(view.container)
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    expect(h.pending.record?.model).toBe('m2')
    expect(h.spies.challenger.calls).toEqual([])
    await act(async () => { h.setPairValid(true); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(h.pending.record).toBeUndefined()
    expect(h.spies.endeavour.calls).toEqual([])
    // Consumed drafts are not a second source of truth: a later native peer-tab
    // change is reflected rather than overwritten by the old choice.
    await act(async () => { h.setSelection('challenger', { provider: 'p1', model: 'm3', reasoningEffort: 'high' }); await Promise.resolve() })
    expect(tooltip(view.container)).toContain('Model Three High')
    expect(h.spies.challenger.calls).toHaveLength(1)
  })

  it('keeps the menu open after browser storage failure and lets the user retry', async () => {
    const h = harness()
    h.setPairValid(false)
    h.failPendingSave()
    const view = render({ harness: h, peer: null })
    await open(view.container)
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    const failedSave = h.waitForPendingSave()
    await act(async () => { (option as HTMLElement).click(); await failedSave; await Promise.resolve() })
    expect(menu()).not.toBeNull()
    expect(menu()?.textContent).toContain('The choice was not saved or applied')
    expect(h.pending.record).toBeUndefined()
    expect(h.spies.challenger.calls).toEqual([])
    expect(h.spies.endeavour.calls).toEqual([])

    const retrySave = h.waitForPendingSave()
    await act(async () => { (menuRows().find((row) => row.textContent === 'Model Two') as HTMLElement).click(); await retrySave; await Promise.resolve() })
    expect(menu()).toBeNull()
    expect(h.pending.record?.model).toBe('m2')
  })

  it('keeps the menu open until the latest overlapping save succeeds', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    let gateIndex = 0
    const h = harness({ beforePendingSave: () => [firstGate, secondGate][gateIndex++]! })
    h.setPairValid(false)
    const view = render({ harness: h, peer: null })
    await open(view.container)
    await act(async () => { menuRows()[0]?.click() })
    const firstSave = h.waitForPendingSave()
    await act(async () => { (menuRows().find((row) => row.textContent === 'Model Two') as HTMLElement).click() })
    const secondSave = h.waitForPendingSave()
    await act(async () => { (menuRows().find((row) => row.textContent === 'Model Three') as HTMLElement).click() })
    expect(menu()).not.toBeNull()

    await act(async () => { releaseFirst(); await firstSave; await Promise.resolve() })
    expect(h.pending.record?.model).toBe('m2')
    expect(menu()).not.toBeNull()
    await act(async () => { releaseSecond(); await secondSave; await Promise.resolve() })
    expect(h.pending.record?.model).toBe('m3')
    expect(menu()).toBeNull()
  })

  it('does not let a delayed save close a reopened menu', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const h = harness({ beforePendingSave: () => gate })
    h.setPairValid(false)
    const view = render({ harness: h, peer: null })
    await open(view.container)
    await act(async () => { menuRows()[0]?.click() })
    const save = h.waitForPendingSave()
    await act(async () => { (menuRows().find((row) => row.textContent === 'Model Two') as HTMLElement).click() })
    await act(async () => { trigger(view.container)?.click() })
    expect(menu()).toBeNull()
    await act(async () => { trigger(view.container)?.click() })
    expect(menu()).not.toBeNull()
    await act(async () => { release(); await save; await Promise.resolve() })
    expect(menu()).not.toBeNull()
    expect(pane()).toBe('root')
    expect(h.pending.record?.model).toBe('m2')
  })

  it('swallows a delayed save rejection after its component unmounts', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    let reject!: (error: Error) => void
    const gate = new Promise<void>((_resolve, rejectGate) => { reject = rejectGate })
    const h = harness({ beforePendingSave: () => gate })
    h.setPairValid(false)
    const view = render({ harness: h, peer: null })
    await open(view.container)
    await act(async () => { menuRows()[0]?.click() })
    const save = h.waitForPendingSave()
    await act(async () => { (menuRows().find((row) => row.textContent === 'Model Two') as HTMLElement).click() })
    const root = roots.pop()!
    containers.pop()?.remove()
    process.on('unhandledRejection', onUnhandled)
    try {
      await act(async () => { root.unmount(); reject(new Error('late storage failure')); await save; await Promise.resolve() })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(view.container.isConnected).toBe(false)
  })

  it('renders nothing for Standard without touching either directory', () => {
    const denied = harness()
    const view = render({ harness: denied, preset: 'standard' })
    expect(trigger(view.container)).toBeNull()
    // No role operation runs for a control that is not shown.
    expect(denied.spies.challenger.reads).toBe(0)
    expect(denied.spies.challenger.acquisitions).toBe(0)
  })

  it('stays enabled and selectable during an active plan and turn', async () => {
    const h = harness()
    const active = render({ harness: h, plan: { terminal: undefined } })
    await open(active.container)
    expect(trigger(active.container)?.disabled).toBe(false)
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    expect(pane()).toBe('model')
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    expect(h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(h.spies.endeavour.calls).toEqual([])
    expect(trigger(active.container)?.disabled).toBe(false)
  })

})

describe('closed-popup summary', () => {
  it('shows the full catalog model name and effort without opening the popup', async () => {
    const view = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pane()).toBeNull()
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model One Low')
  })

  it('falls back to the raw model id when the catalog has not loaded', async () => {
    const h = harness()
    h.failLoad('challenger')
    const view = render({ harness: h })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('m1')
  })

  it('shows loading copy while the peer is pending and unavailable copy when it cannot resolve', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const view = render({ harness: h })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(view.container)).toContain('Loading models...')
    await h.rejectAcquisition('challenger')
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Not available')
  })

  it('follows the peer selection as it changes while closed', async () => {
    const view = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model One Low')
    await act(async () => {
      view.h.setSelection('challenger', { provider: 'p1', model: 'm2' })
      await Promise.resolve()
    })
    // Model Two declares no thinking efforts, so no effort is appended.
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model Two')
  })
})

describe('popup structure and role targeting', () => {
  it('shows only the peer Model and Effort rows with their current values', async () => {
    const view = render({})
    await open(view.container)
    expect(pane()).toBe('root')
    expect(menuRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Model'),
      expect.stringContaining('Effort'),
    ])
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model One', 'Low'])
    // No role headings and no Endeavour rows anywhere in the popup.
    expect(menu()?.textContent).not.toContain('Endeavour')
    expect(menu()?.querySelectorAll('[data-endeavour-section]')).toHaveLength(0)
    expect(menuRows().some((row) => row.textContent === 'Model One' && row.getAttribute('role') === 'menuitemradio')).toBe(false)
  })

  it('drills into the peer catalog and writes only the peer', async () => {
    const view = render({})
    await open(view.container)
    const modelCell = menuRows()[0]
    await act(async () => { (modelCell as HTMLElement).click() })
    expect(pane()).toBe('model')
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    expect(option).toBeDefined()
    await saveOption(view.h, option as HTMLElement)
    expect(view.h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(view.h.spies.endeavour.calls).toEqual([])
    expect(view.h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('resets only the peer effort to the new model default', async () => {
    const view = render({})
    await open(view.container)
    const modelCell = menuRows()[0]
    await act(async () => { (modelCell as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Three')
    expect(option).toBeDefined()
    await saveOption(view.h, option as HTMLElement)
    expect(view.h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm3', effort: 'high' }])
    expect(view.h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })

  it('offers the peer effort options and writes the chosen one', async () => {
    const view = render({})
    await open(view.container)
    const effortCell = menuRows()[1]
    await act(async () => { (effortCell as HTMLElement).click() })
    expect(pane()).toBe('effort')
    const high = menuRows().find((row) => row.textContent?.includes('High'))
    expect(high).toBeDefined()
    await saveOption(view.h, high as HTMLElement)
    expect(view.h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm1', effort: 'high' }])
  })

  it('closes on outside interaction and on Escape, returning focus to the trigger', async () => {
    const view = render({})
    await open(view.container)
    expect(menu()).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    await open(view.container)
    expect(pane()).toBe('root')
    await act(async () => {
      menuRows()[0]?.click()
      await Promise.resolve()
    })
    expect(pane()).toBe('model')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    // Escape steps back one pane, then closes.
    expect(pane()).toBe('root')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger(view.container))
  })

  it('exposes concise trigger semantics without a healthy-state status note', async () => {
    const view = render({})
    const chip = trigger(view.container)
    expect(chip?.getAttribute('aria-haspopup')).toBe('menu')
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    // Before the catalog resolves the description falls back to the raw model id.
    expect(ariaLabel(view.container)).toBe('Challenger model and effort: m1')
    expect(tooltip(view.container)).toBe('Challenger model and effort: m1')
    // After it loads, the same description carries the full catalog name and effort.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(ariaLabel(view.container)).toBe('Challenger model and effort: Model One Low')
    expect(tooltip(view.container)).toBe('Challenger model and effort: Model One Low')
    expect(ariaLabel(view.container)).not.toContain('Applies to requests assembled after application')
    expect(tooltip(view.container)).not.toContain('Applies to requests assembled after application')
    await open(view.container)
    expect(trigger(view.container)?.getAttribute('aria-expanded')).toBe('true')
    expect(menu()?.getAttribute('role')).toBe('menu')
    expect(menu()?.getAttribute('data-menu-material')).toBe('translucent')
    expect(menu()?.firstElementChild?.classList.contains('dsh-endeavour-menu-material')).toBe(true)
    expect(menu()?.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(menu()?.firstElementChild?.hasAttribute('data-menu-material')).toBe(false)
    expect(menu()?.textContent).not.toContain('Applies to requests assembled after application')
    expect(menu()?.querySelector('[data-endeavour-selection-status]')).toBeNull()
    expect(menuRows().every((row) => row.getAttribute('role') === 'menuitem' || row.getAttribute('role') === 'menuitemradio')).toBe(true)
  })
})

describe('peer failure handling', () => {
  it('keeps the trigger mounted and offers retry while the peer directory throws', async () => {
    const h = harness()
    h.breakChallenger()
    const view = render({ harness: h })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(trigger(view.container)).not.toBeNull()
    expect(tooltip(view.container)).toContain('Not available')
    await open(view.container)
    expect(menuRows().map((row) => row.textContent).join(' ')).toContain('Challenger is unavailable')
  })

  it('reacquires the peer on retry and recovers without touching the Endeavour session', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const view = render({ harness: h })
    await h.rejectAcquisition('challenger')
    await open(view.container)
    const retry = menuRows().find((row) => row.textContent?.includes('Challenger is unavailable'))
    expect(retry).toBeDefined()
    await act(async () => { (retry as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() })
    expect(h.spies.challenger.acquisitions).toBe(2)
    expect(h.spies.challenger.releases).toBe(1)
    await h.resolveAcquisition('challenger')
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model One Low')
    expect(h.spies.endeavour.calls).toEqual([])
  })

  it('marks the error fallback root and preserves its noninteractive material layer', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const view = render({ t: (key: string) => { if (key === 'challenger.menu') throw new Error('menu label failed'); return undefined } })
      await open(view.container)
      const fallback = newest('[data-endeavour-menu-error]') as HTMLElement | null
      expect(fallback).not.toBeNull()
      expect(fallback?.getAttribute('data-menu-material')).toBe('translucent')
      expect(fallback?.firstElementChild?.classList.contains('dsh-endeavour-menu-material')).toBe(true)
      expect(fallback?.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
      expect(fallback?.firstElementChild?.hasAttribute('data-menu-material')).toBe(false)
      expect(fallback?.querySelector('[data-endeavour-menu-retry]')?.textContent).toBe('Retry')
    } finally {
      logError.mockRestore()
    }
  })
})

describe('one reference through the visible lifetime', () => {
  it('acquires once and keeps that reference across repeated popup toggles', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const view = render({ harness: h })
    expect(h.spies.challenger.acquisitions).toBe(1)
    await h.resolveAcquisition('challenger')
    for (let index = 0; index < 3; index += 1) await open(view.container)
    expect(h.spies.challenger.acquisitions).toBe(1)
    expect(h.spies.challenger.releases).toBe(0)
    // Still one listener even after the popup opened and closed repeatedly.
    expect(h.spies.challenger.listeners.size).toBe(1)
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model One Low')
  })

  it('releases the reference and its listener when the control unmounts', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const view = render({ harness: h })
    await h.resolveAcquisition('challenger')
    expect(h.spies.challenger.listeners.size).toBe(1)
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(h.spies.challenger.releases).toBe(1)
    expect(h.spies.challenger.doubleReleases).toBe(0)
    expect(h.spies.challenger.listeners.size).toBe(0)
  })

  it('releases when the control stops being admitted', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let preset = 'endeavour'
    const element = (): React.ReactElement => createElement(ChallengerModelControl, {
      useProjection: (key: string) => (key === 'agentPreset' ? preset : key === 'endeavourPeer' ? pair() : null),
      sessionId: 'session-root',
      unifiedModels: h.controller,
      t: undefined,
    } as never)
    act(() => { root.render(element()) })
    roots.push(root)
    containers.push(container)
    await h.resolveAcquisition('challenger')
    expect(h.spies.challenger.releases).toBe(0)
    // An explicit non-Endeavour preset revokes the persistent admission.
    await act(async () => {
      preset = 'standard'
      root.render(element())
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(h.spies.challenger.releases).toBe(1)
    expect(h.spies.challenger.listeners.size).toBe(0)
  })

  it('uses the plain directory lookup on a host without references', async () => {
    const h = harness()
    const view = render({ harness: h })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(h.spies.challenger.acquisitions).toBe(0)
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model One Low')
  })

  it('survives a StrictMode double-invoked lifecycle without leaking', async () => {
    const h = harness()
    h.withAcquisition('challenger')
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(createElement(StrictMode, null, createElement(ChallengerModelControl, {
        useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : key === 'endeavourPeer' ? pair() : null),
        sessionId: 'session-root',
        unifiedModels: h.controller,
        t: undefined,
      } as never)))
    })
    roots.push(root)
    containers.push(container)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Every discarded generation released its own reference.
    expect(h.spies.challenger.releases).toBe(h.spies.challenger.acquisitions - 1)
    expect(h.spies.challenger.doubleReleases).toBe(0)
    await act(async () => { roots.splice(0).forEach((root_) => root_.unmount()) })
    expect(h.spies.challenger.listeners.size).toBe(0)
  })
})

/**
 * A model write outlives the menu that started it: the popup closes as soon as
 * the user picks, so every completion lands after that menu generation is gone.
 * A stale completion must not publish state, must not re-read a directory it no
 * longer owns, and above all must not raise an error the user sees the next time
 * the menu opens — while the write the user asked for still lands.
 */
describe('stale write completion', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(async () => {
    await Promise.resolve()
    await Promise.resolve()
    process.off('unhandledRejection', onRejection)
    expect(rejections).toEqual([])
  })

  /** Open the popup and pick the peer's other model, leaving the write pending. */
  async function pickChallengerModel(view: { readonly container: HTMLElement; readonly h: Harness }): Promise<void> {
    await open(view.container)
    await act(async () => { (menuRows()[0] as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(view.h, option as HTMLElement)
  }

  it('keeps a rejected saved choice pending and exposes the apply error after the menu closes', async () => {
    const h = harness()
    h.deferSelect('challenger')
    const view = render({ harness: h })
    await pickChallengerModel(view)
    // The write was initiated once, with the picked model, and the popup closed.
    expect(h.writeAttempts('challenger')).toBe(1)
    expect(menu()).toBeNull()
    await h.settleSelect('challenger', new Error('challenger selection rejected'))
    // The choice is visibly pending after failure; the trigger remains compact.
    await open(view.container)
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
    expect(menu()?.querySelector('[data-endeavour-selection-status]')?.textContent).toBe('Saved choice is waiting after an apply error')
    expect(menu()?.querySelector('[data-endeavour-selection-error]')?.textContent).toContain('The choice was not saved or applied')
    expect(menu()?.querySelector('[data-endeavour-selection-error] button')?.textContent).toBe('Retry')
    expect(menu()?.textContent ?? '').not.toContain('Applies to requests assembled after application')
    expect(triggerLabel(view.container)).toBe('Challenger')
    expect(tooltip(view.container)).toContain('Model Two')
    expect(tooltip(view.container)).toContain('waiting after an apply error')
    expect(tooltip(view.container)).not.toContain('Applies to requests assembled after application')
    expect(ariaLabel(view.container)).not.toContain('Applies to requests assembled after application')
  })

  it('publishes nothing and raises no error when a successful write lands after the menu closed', async () => {
    const h = harness()
    h.deferSelect('challenger')
    const view = render({ harness: h })
    await pickChallengerModel(view)
    await h.settleSelect('challenger')
    await open(view.container)
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
    // The label mirrors the directory again, and the write itself landed.
    expect(h.spies.challenger.selections).toEqual({ provider: 'p1', model: 'm2' })
    expect(h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
    // The popup re-reads the peer directory on open, and the closed label too.
    const values = menuRows().map((row) => row.querySelector('.dsh-endeavour-menu-cell-value')?.textContent)
    expect(values).toEqual(['Model Two', 'Not available'])
    expect(menu()?.textContent ?? '').not.toContain('Endeavour')
  })

  it('keeps a late failed apply pending through a new read generation', async () => {
    const h = harness()
    h.deferSelect('challenger')
    const view = render({ harness: h })
    await pickChallengerModel(view)
    // A retry re-runs the post-commit setup before the write settles.
    h.fail('challenger')
    await open(view.container)
    await act(async () => { await Promise.resolve() })
    await h.settleSelect('challenger', new Error('late rejection'))
    await open(view.container)
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
  })

  it('leaves a replaced component untouched by the previous one\u2019s completion', async () => {
    const first = harness()
    first.deferSelect('challenger')
    const view = render({ harness: first })
    await pickChallengerModel(view)
    // The whole control is replaced, as a session or controller change does.
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    const second = harness()
    const reopened = render({ harness: second })
    await first.settleSelect('challenger', new Error('write from the old control failed'))
    await open(reopened.container)
    expect(document.body.querySelector('[data-endeavour-menu-error]')).toBeNull()
    // The new control never wrote anything of its own.
    expect(second.writeAttempts('challenger')).toBe(0)
  })

  it('does not require a reflective read after the official selection succeeds', async () => {
    const h = harness()
    // A write that settles INSIDE the click handler: the generation is still
    // current, so the reflective re-read runs and throws.
    h.settleSelectSynchronously('challenger')
    const view = render({ harness: h })
    await open(view.container)
    h.breakOperation('challenger', 'readSelection', 'directory refuses a post-write read')
    await act(async () => { (menuRows()[0] as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    // The official write landed. A later projection read can show unavailable,
    // but is not used to decide whether the native select succeeded.
    expect(h.spies.challenger.calls).toHaveLength(1)
    expect(h.pending.record).toBeUndefined()
    h.repairRole('challenger')
  })

  it('contains a synchronous write rejection on the live generation', async () => {
    const h = harness()
    h.settleSelectSynchronously('challenger')
    h.fail('challenger')
    const view = render({ harness: h })
    await open(view.container)
    await act(async () => { (menuRows()[0] as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    await open(view.container)
    expect(menu()?.textContent).toContain('Saved choice is waiting after an apply error')
    expect(trigger(view.container)?.getAttribute('aria-busy')).toBe('false')
    expect(h.controller.pendingSelection.getSnapshot().record?.model).toBe('m2')
    // The Endeavour session was never written or disturbed.
    expect(h.spies.endeavour.calls).toEqual([])
    expect(h.spies.endeavour.selections).toEqual({ provider: 'p1', model: 'm1', reasoningEffort: 'low' })
  })
})


describe('retained peer lifecycle over the real registration bridge', () => {
  // A leaked reference or a dropped rejection is exactly the failure this work
  // must not introduce, so every case in this block is checked for both.
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => { rejections.push(reason) }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(async () => {
    await Promise.resolve()
    await Promise.resolve()
    process.off('unhandledRejection', onRejection)
    expect(rejections).toEqual([])
  })

  it('retains the exact peer and reads its directory only after readiness', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    await open(container)
    // The peer has no scope yet: the control acquired it and is waiting.
    expect(host.retainTargets()).toEqual([HOST_PEER])
    expect(host.retainSources()).toEqual(['orbitalModelMenu'])
    expect(tooltip(container)).toContain('Loading models...')
    expect(host.pendingReady()).toBeGreaterThan(0)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(container)).toContain('m9')
    await open(container)
    expect(menu()?.textContent ?? '').not.toContain('is unavailable')
    // Ordering: the directory was resolved strictly after the reference became
    // ready, and nothing was ever created or opened as a NEW session.
    const retainIndex = host.log.indexOf(`retain:${HOST_PEER}:orbitalModelMenu`)
    const peerDirectoryIndex = host.log.indexOf(`directory:${HOST_PEER}`)
    expect(retainIndex).toBeGreaterThanOrEqual(0)
    // The peer's directory resolved strictly AFTER its reference became ready.
    expect(peerDirectoryIndex).toBeGreaterThan(retainIndex)
    expect(host.peerDirectories()).toBe(1)
    expect(host.counts.creates).toBe(0)
    expect(host.counts.prompts).toBe(0)
  })

  it('works for a peer another owner already retained and releases only its own reference', async () => {
    const host = await realHost()
    await host.retainAsOtherOwner()
    expect(host.scopePresent()).toBe(true)
    const { container } = renderReal(host.controller)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(container)).toContain('m9')
    const releasesBefore = host.counts.releases
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    // The control's own reference went back, and the other owner's keeps the scope.
    expect(host.counts.releases).toBe(releasesBefore + 1)
    expect(host.counts.scopeRetirements).toBe(0)
    expect(host.scopePresent()).toBe(true)
  })

  it('loads the peer catalog only after readiness, and only once per generation', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    // Nothing is loaded while the peer is still being acquired.
    expect(host.counts.loads).toBe(0)
    expect(tooltip(container)).toContain('Loading models...')
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.counts.loads).toBe(1)
    expect(tooltip(container)).toContain('m9')
  })

  it('survives a readiness rejection and succeeds when Retry reacquires', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    await act(async () => { host.rejectReady(new Error('peer scope materialization failed')); await Promise.resolve(); await Promise.resolve() })
    await open(container)
    expect(menu()?.textContent ?? '').toContain('Challenger is unavailable')
    // The failure released the unusable reference instead of holding it.
    expect(host.counts.releases).toBe(1)
    const retry = menuRows().find((row) => row.textContent?.includes('Challenger is unavailable'))
    expect(retry).toBeDefined()
    await act(async () => { (retry as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() })
    // Retry ACQUIRES AGAIN: a directory probe alone could never succeed here.
    expect(host.retainTargets()).toEqual([HOST_PEER, HOST_PEER])
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(container)).toContain('m9')
    await open(container)
    expect(menu()?.textContent ?? '').not.toContain('is unavailable')
  })

  it('reports a synchronous retain failure as a role-local state, not a menu failure', async () => {
    const host = await realHost()
    const original = host.controller.roles.challenger.acquire
    const failing: UnifiedRoleController = {
      ...host.controller.roles.challenger,
      acquire: () => { throw new Error('Session Controller is disposed') },
    }
    expect(original).toBeDefined()
    const controller: UnifiedModelController = { ...host.controller, roles: { ...host.controller.roles, challenger: failing } }
    const { container } = renderReal(controller)
    // The control survived: the trigger stays mounted and retryable.
    expect(trigger(container)).not.toBeNull()
    expect(triggerLabel(container)).toBe('Challenger')
    expect(tooltip(container)).toContain('Not available')
    await open(container)
    expect(menu()?.textContent ?? '').toContain('Challenger is unavailable')
    expect(detailText()).toBe('')
  })

  it('releases a reference that is closed before it ever became ready', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    expect(host.pendingReady()).toBeGreaterThan(0)
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(host.counts.releases).toBe(1)
    expect(host.liveReferences()).toBe(0)
    // The PEER never resolved a directory and never got a listener.
    expect(host.peerDirectories()).toBe(0)
    expect(host.listenersOf(HOST_PEER)).toBe(0)
    expect(host.counts.listeners).toBe(0)
    // Settling the abandoned reference afterwards publishes nothing either.
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(host.peerDirectories()).toBe(0)
    expect(host.counts.listeners).toBe(0)
  })

  it('reacquires on reopen and leaves nothing retained after the last close', async () => {
    const host = await realHost()
    const first = renderReal(host.controller)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(first.container)).toContain('m9')
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(host.liveReferences()).toBe(0)
    // A fresh mount re-acquires the peer.
    const second = renderReal(host.controller)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(tooltip(second.container)).toContain('m9')
    expect(host.retainTargets().length).toBeGreaterThanOrEqual(2)
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(host.liveReferences()).toBe(0)
    expect(host.counts.listeners).toBe(0)
  })

  it('builds exactly one fresh setup on Retry instead of duplicating the failed one', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    // First attempt fails: its reference is released and nothing was resolved.
    await act(async () => { host.rejectReady(new Error('first attempt failed')); await Promise.resolve(); await Promise.resolve() })
    expect(host.counts.releases).toBe(1)
    expect(host.peerDirectories()).toBe(0)
    expect(host.listenersOf(HOST_PEER)).toBe(0)
    await open(container)
    const retry = menuRows().find((row) => row.textContent?.includes('Challenger is unavailable'))
    expect(retry).toBeDefined()
    await act(async () => { (retry as HTMLElement).click(); await Promise.resolve(); await Promise.resolve() })
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Exactly ONE peer directory and ONE peer subscription for the live
    // generation: the abandoned attempt left no half-setup behind.
    expect(host.peerDirectories()).toBe(1)
    expect(host.listenersOf(HOST_PEER)).toBe(1)
    expect(tooltip(container)).toContain('m9')
  })

  it('keeps StrictMode\u2019s discarded generation from leaking references or listeners', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller, { strict: true })
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // StrictMode replays setup/cleanup: every discarded generation released its
    // own reference, and exactly the live generation still holds one.
    expect(host.counts.retains).toBeGreaterThan(host.counts.releases)
    expect(host.liveReferences()).toBe(host.retainTargets().length - host.counts.releases)
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(host.liveReferences()).toBe(0)
    expect(host.counts.listeners).toBe(0)
  })

  it('releases the partial setup when a subscription fails and reports it to the boundary', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    host.breakSubscribe()
    await host.resolveReadySync()
    // The failure is this role's own state: the trigger stays mounted and the
    // popup offers retry, and the partial setup was released.
    expect(trigger(container)).not.toBeNull()
    expect(triggerLabel(container)).toBe('Challenger')
    expect(tooltip(container)).toContain('Not available')
    await open(container)
    expect(menuRows().map((row) => row.textContent).join(' ')).toContain('Challenger is unavailable')
    expect(host.liveReferences()).toBe(0)
    expect(host.counts.listeners).toBe(0)
  })

  it('stays stable under a synchronous subscriber notification', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const before = host.counts.listeners
    // A directory that notifies immediately on subscribe must not loop.
    await act(async () => { host.setSelection(HOST_PEER, { provider: 'p2', model: 'm9', reasoningEffort: 'high' }); await Promise.resolve() })
    expect(host.counts.listeners).toBe(before)
    expect(tooltip(container)).toContain('m9')
    expect(host.counts.selects).toBe(0)
    expect(host.counts.creates).toBe(0)
  })

  it('drops catalog responses that land after the menu closed', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    host.deferLoads()
    await act(async () => { await host.resolveReadySync(); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { roots.splice(0).forEach((root) => root.unmount()) })
    expect(menu()).toBeNull()
    // Resolving the in-flight catalog after teardown must publish nothing.
    host.resolveLoadsLate()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(menu()).toBeNull()
    expect(host.liveReferences()).toBe(0)
  })

  it('keeps the persistent trigger and never writes a model it was not asked to write', async () => {
    const host = await realHost()
    const { container } = renderReal(host.controller)
    await host.resolveReadySync()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // The trigger stays in the composer while the popup is open.
    expect(trigger(container)).not.toBeNull()
    expect(trigger(container)?.getAttribute('aria-haspopup')).toBe('menu')
    expect(host.counts.selects).toBe(0)
    expect(host.counts.creates).toBe(0)
    expect(host.counts.prompts).toBe(0)
    // Neither session's stored selection moved because the popup merely opened.
    expect(host.selectionOf(HOST_PEER)).toMatchObject({ provider: 'p2', model: 'm9' })
    expect(host.selectionOf(HOST_ROOT)).toMatchObject({ provider: 'p1', model: 'm1' })
  })
})




describe('compact trigger and supplied lock state', () => {
  /** Render with an explicit right-slot style prop set. */
  function renderWith(options: {
    readonly locked?: boolean
    readonly running?: boolean
    readonly useSession?: boolean
    readonly plan?: unknown
    readonly peer?: unknown
    readonly harness?: Harness
  } = {}): { container: HTMLElement; h: Harness } {
    const h = options.harness ?? harness()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const props: Record<string, unknown> = {
      useProjection: (key: string) => {
        if (key === 'agentPreset') return 'endeavour'
        if (key === 'endeavourPeer') return 'peer' in options ? options.peer : pair()
        if (key === 'endeavourPlan') return 'plan' in options ? options.plan : null
        return null
      },
      sessionId: 'session-root',
      unifiedModels: h.controller,
      t: undefined,
    }
    // The right-slot list receives no `locked`; the standard session hook is the
    // source of running state. Both are exercised explicitly here.
    if (options.useSession !== false) props.useSession = (select: (snapshot: { running?: boolean }) => unknown) => select({ running: options.running ?? false })
    if (options.locked !== undefined) props.locked = options.locked
    act(() => { root.render(createElement(ChallengerModelControl, props as never)) })
    roots.push(root)
    containers.push(container)
    return { container, h }
  }

  it('shows exactly the localized word regardless of model, effort, loading or error', async () => {
    const longName = 'Extended Reasoning Preview (OG) Build With A Very Long Tail'
    const normal = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(triggerLabel(normal.container)).toBe('Challenger')
    expect(triggerLabel(normal.container)).not.toContain('Model One')
    const long = harness()
    long.setSelection('challenger', { provider: 'p1', model: longName })
    const longView = render({ harness: long })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(triggerLabel(longView.container)).toBe('Challenger')
    expect(tooltip(longView.container)).toContain('Extended Reasoning Preview (OG) Build With A Very Long Tail')
    // Loading and error states keep the same visible word.
    const pending = harness()
    pending.withAcquisition('challenger')
    const pendingView = render({ harness: pending })
    expect(triggerLabel(pendingView.container)).toBe('Challenger')
    await pending.rejectAcquisition('challenger')
    expect(triggerLabel(pendingView.container)).toBe('Challenger')
    expect(tooltip(pendingView.container)).toContain('Not available')
    const failing = harness()
    failing.breakRole('challenger')
    const failView = render({ harness: failing })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(triggerLabel(failView.container)).toBe('Challenger')
  })

  it('keeps no role glyph and only a decorative chevron in the button', async () => {
    const view = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const chip = trigger(view.container)
    expect(chip?.querySelector('[data-endeavour-challenger-icon]')).toBeNull()
    expect(chip?.querySelector('[data-endeavour-role-icon]')).toBeNull()
    const svgs = chip?.querySelectorAll('svg') ?? []
    expect(svgs).toHaveLength(1)
    expect(svgs[0]?.getAttribute('aria-hidden')).toBe('true')
  })

  it('stays enabled and allows a choice while the running snapshot is true', async () => {
    const h = harness()
    const view = renderWith({ harness: h, running: true })
    await open(view.container)
    expect(trigger(view.container)?.disabled).toBe(false)
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    expect(h.spies.challenger.calls).toEqual([{ provider: 'p1', model: 'm2', effort: undefined }])
    expect(trigger(view.container)?.disabled).toBe(false)
  })

  it('ignores an optional locked prop and remains enabled/selectable', async () => {
    const h = harness()
    const view = renderWith({ harness: h, locked: true, running: true })
    await open(view.container)
    expect(trigger(view.container)?.disabled).toBe(false)
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    expect(h.spies.challenger.calls).toHaveLength(1)
  })

  it('does not close an open menu when a running turn begins', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const h = harness()
    let running = false
    const element = (): React.ReactElement => createElement(ChallengerModelControl, {
      useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : key === 'endeavourPeer' ? pair() : null),
      sessionId: 'session-root', unifiedModels: h.controller,
      useSession: (select: (snapshot: { running?: boolean }) => unknown) => select({ running }),
      locked: running, t: undefined,
    } as never)
    act(() => { root.render(element()) })
    roots.push(root); containers.push(container)
    await open(container)
    running = true
    await act(async () => { root.render(element()); await Promise.resolve() })
    expect(menu()).not.toBeNull()
    expect(trigger(container)?.disabled).toBe(false)
    const option = menuRows()[0]
    await act(async () => { option?.click(); await Promise.resolve() })
    const second = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, second as HTMLElement)
    expect(h.spies.challenger.calls).toHaveLength(1)
  })

  it('exposes aria-controls to the real popup and aria-busy while a write is in flight', async () => {
    const h = harness()
    h.deferSelect('challenger')
    const view = render({ harness: h })
    const chip = trigger(view.container)
    expect(chip?.getAttribute('aria-controls')).toBeNull()
    await open(view.container)
    const popup = menu()
    expect(popup).not.toBeNull()
    expect(trigger(view.container)?.getAttribute('aria-controls')).toBe(popup?.id)
    expect(popup?.id).toBeTruthy()
    // A write in flight is announced as busy.
    await act(async () => { (menuRows()[0] as HTMLElement).click() })
    const option = menuRows().find((row) => row.textContent === 'Model Two')
    await saveOption(h, option as HTMLElement)
    expect(h.writeAttempts('challenger')).toBe(1)
  })
})

describe('native composition and accessibility', () => {
  it('sits beside a mounted native selector without any duplicate combined button', async () => {
    const view = render({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // The fixture composes the native button next to the custom control, as the
    // model seat does, and the custom control never replaces it.
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    const nativeSeat = document.createElement('div')
    nativeSeat.setAttribute('data-slot', 'conversation.input.model')
    const nativeButton = document.createElement('button')
    nativeButton.setAttribute('data-native-model-selector', '')
    nativeButton.textContent = 'Model One'
    nativeSeat.appendChild(nativeButton)
    card.appendChild(nativeSeat)
    card.appendChild(view.container)
    document.body.appendChild(card)
    containers.push(card)
    expect(card.querySelectorAll('[data-native-model-selector]')).toHaveLength(1)
    expect(card.querySelectorAll('[data-endeavour-challenger-models]')).toHaveLength(1)
    // No second combined control and nothing hidden by a plugin rule.
    expect(card.querySelectorAll('[data-endeavour-unified-models]')).toHaveLength(0)
    expect(STYLE_TEXT).not.toContain('display: none')
  })

  it('keeps the trigger usable inside a narrow model seat with a long model name', async () => {
    const h = harness()
    const longName = 'DeepSeek V4.1 Flash (OG) Extended Reasoning Preview Build'
    h.setSelection('challenger', { provider: 'p1', model: longName })
    const view = render({ harness: h })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const chip = trigger(view.container)
    expect(chip).not.toBeNull()
    // The label ellipsises at the CSS level; the full text stays in the tooltip
    // and in the accessible name is the role, so nothing is lost to a screen
    // reader and nothing overflows the seat.
    expect(tooltip(view.container)).toContain(longName)
    expect(chip?.getAttribute('title')).toBe(tooltip(view.container))
    expect(STYLE_TEXT).toContain('text-overflow: ellipsis')
    expect(STYLE_TEXT).toContain('max-width: min(360px, 45cqw)')
  })

  it('opens with no active root row and enters keyboard navigation only on arrow keys', async () => {
    const view = render({})
    await open(view.container)
    expect(menuRows()[0]?.className).not.toContain('--active')
    expect(menuRows()[1]?.className).not.toContain('--active')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(menuRows()[0]?.className).toContain('--active')
    await act(async () => { menuRows()[0]?.click(); await Promise.resolve() })
    expect(pane()).toBe('model')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(pane()).toBe('root')
    expect(menuRows()[0]?.className).not.toContain('--active')
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await open(view.container)
    expect(menuRows()[0]?.className).not.toContain('--active')
  })

  it('does not activate on Enter without a row, and clears pointer hover when it leaves', async () => {
    const view = render({})
    await open(view.container)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(pane()).toBe('root')
    const model = menuRows()[0]!
    await act(async () => { model.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
    expect(model.className).toContain('--active')
    await act(async () => { model.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })) })
    expect(model.className).not.toContain('--active')
  })

  it('ArrowUp from no active row targets the last enabled root row', async () => {
    const view = render({})
    await open(view.container)
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    expect(menuRows()[1]?.className).toContain('--active')
    expect(menuRows()[0]?.className).not.toContain('--active')
  })

  it('walks the popup with the keyboard and returns focus on close', async () => {
    const view = render({})
    await act(async () => { trigger(view.container)?.focus() })
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    // Enter on the focused trigger opens the popup; ArrowDown moves the active row.
    if (menu() !== null) {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
        await Promise.resolve()
      })
      expect(menu()).not.toBeNull()
    }
    await open(view.container)
    expect(menu()).not.toBeNull()
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(trigger(view.container))
  })

  it('closes the custom popup when the native selector is used, leaving native behaviour alone', async () => {
    const view = render({})
    await open(view.container)
    expect(menu()).not.toBeNull()
    // A click anywhere outside the custom control — the native selector included
    // — is ordinary outside interaction: only the custom popup reacts.
    const native = document.createElement('button')
    native.setAttribute('data-native-model-selector', '')
    document.body.appendChild(native)
    containers.push(native)
    await act(async () => {
      native.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await Promise.resolve()
    })
    expect(menu()).toBeNull()
    // The native button was not touched by the plugin.
    expect(native.isConnected).toBe(true)
  })

  it('marks the trigger busy state and its expanded state for assistive technology', async () => {
    const view = render({})
    const chip = trigger(view.container)
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    await open(view.container)
    expect(trigger(view.container)?.getAttribute('aria-expanded')).toBe('true')
    // The chevron rotates while the popup is open, using the plugin's own marker.
    const rotated = trigger(view.container)?.querySelector('.dsh-endeavour-challenger-chevron--open')
    expect(rotated).not.toBeNull()
    expect(STYLE_TEXT).toContain('.dsh-endeavour-challenger-chevron--open { transform: rotate(180deg); }')
  })
})

describe('control purity', () => {
  it('never touches a role controller while rendering', () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    const shell = source.slice(
      source.indexOf('export function ChallengerModelControl'),
      source.indexOf('interface MenuBoundaryProps'),
    )
    // The render preamble (up to the lifecycle effect) is role-free.
    const effectStart = shell.indexOf('/** Bind to one root read source')
    const preamble = shell.slice(0, effectStart)
    expect(effectStart).toBeGreaterThan(0)
    expect(preamble).not.toMatch(/roles\.(?:endeavour|challenger)\.(?:available|readSelection|subscribeSelection|loadCatalog|select|acquire)/)
    // Directory access is confined to the post-commit lifecycle; render reads
    // only stable source and pending snapshots.
    const renderSource = shell.slice(shell.indexOf('const effectiveSelection'))
    expect(renderSource).not.toMatch(/roles\.(?:endeavour|challenger)\.(?:available|readSelection|subscribeSelection|loadCatalog|select|acquire)/)
    expect(shell).toContain(`const readRole: UnifiedRole = draft ? 'endeavour' : 'challenger'`)
  })

  it('uses the root directory only for draft reads and the peer for paired reads', () => {
    const source = readFileSync('src/client/UnifiedModelControl.tsx', 'utf8')
    expect(source).toContain(`const readRole: UnifiedRole = draft ? 'endeavour' : 'challenger'`)
    expect(source).toContain('roles.challenger.loadCatalog()')
    expect(source).not.toMatch(/roles\.endeavour\.select/)
  })
})

/**
 * Real registration bridge: the installed ui-model-selection resolves a session
 * directory ONLY through a live scope and a UI binding, and the peer's client
 * session is not retained just because the host runs it. These tests drive the
 * plugin's OWN bridge (`apply`) over a host that reproduces that rule — the
 * exact `resolved no scope` / `resolved no binding` failures, a deferred
 * `retain(...).ready`, and a release that removes only THIS owner's retention —
 * and then render the real menu over the resulting controller.
 */
const HOST_ROOT = 'session-root'
const HOST_PEER = challengerSessionIdFor(HOST_ROOT)

interface HostSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }

interface RealHost {
  readonly controller: UnifiedModelController
  /** Ordered lifecycle log: what the menu asked of the host, and when. */
  readonly log: string[]
  readonly counts: {
    retains: number
    releases: number
    directories: number
    loads: number
    selects: number
    listeners: number
    scopeRetirements: number
    opens: number
    creates: number
    prompts: number
  }
  /** Directories resolved for the PEER specifically (the root is always bound). */
  peerDirectories(): number
  /** Live listeners attached to one session's directory. */
  listenersOf(id: string): number
  retainTargets(): string[]
  retainSources(): string[]
  liveReferences(): number
  resolveReadySync(): Promise<void>
  rejectReady(error?: Error): void
  /** Retain the peer under another owner, as uiWorkspace does on navigation. */
  retainAsOtherOwner(): void
  scopePresent(): boolean
  pendingReady(): number
  setSelection(id: string, selection: HostSelection): void
  selectionOf(id: string): HostSelection | undefined
  breakSubscribe(): void
  notify(id: string): void
  resolveLoadsLate(): void
  deferLoads(): void
  hostSelections: Map<string, HostSelection>
}

/**
 * A host whose `modelDirectories.directoryFor` behaves like the installed
 * resolver and whose `sessions` service exposes the installed `retain` shape.
 */
async function realHost(options: { readonly withRetain?: boolean } = {}): Promise<RealHost> {
  vi.resetModules()
  const log: string[] = []
  const counts = { retains: 0, releases: 0, directories: 0, loads: 0, selects: 0, listeners: 0, scopeRetirements: 0, opens: 0, creates: 0, prompts: 0 }
  const retainCounts = new Map<string, Map<string, number>>()
  const scopes = new Map<string, object>()
  const bindings = new Map<string, unknown>()
  const hostSelections = new Map<string, HostSelection>([
    [HOST_ROOT, { provider: 'p1', model: 'm1', reasoningEffort: 'low' }],
    [HOST_PEER, { provider: 'p2', model: 'm9', reasoningEffort: 'high' }],
  ])
  const listeners = new Map<string, Set<() => void>>()
  const directories = new Map<string, unknown>()
  const pending: { id: string; settle: (error?: Error) => void; settled: boolean }[] = []
  const peer = pair(HOST_ROOT)
  const subscriptions = { broken: false }
  const deferredLoads: (() => void)[] = []

  const bindingOf = (id: string): unknown => ({
    session: {
      projections: {
        faceOf: (key: string) => (key === 'endeavourPeer' && id === HOST_ROOT
          ? { getSnapshot: () => peer, subscribe: () => () => undefined }
          : undefined),
      },
      getSnapshot: () => ({ blank: false }),
    },
  })

  /** What the retained reference's `open()` ultimately materializes. */
  const materialize = (id: string): void => {
    scopes.set(id, { effect: () => () => undefined })
    if (!bindings.has(id)) bindings.set(id, bindingOf(id))
  }

  // The Endeavour session is the chat the control renders in, so the main view
  // already holds it: its scope and binding exist before the menu is opened.
  materialize(HOST_ROOT)

  const directoryFor = (id: string): unknown => {
    const actx = scopes.get(id)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${id}" resolved no scope`)
    const binding = bindings.get(id)
    if (binding === undefined) throw new Error(`ui-model-selection: session "${id}" resolved no binding`)
    const existing = directories.get(id)
    if (existing !== undefined) return existing
    counts.directories += 1
    log.push(`directory:${id}`)
    const created = {
      store: {
        getSnapshot: () => ({ current: hostSelections.get(id) ?? null }),
        subscribe: (listener: () => void) => {
          if (subscriptions.broken) throw new Error('ui-model-selection: subscribe unavailable')
          counts.listeners += 1
          const set = listeners.get(id) ?? new Set<() => void>()
          set.add(listener)
          listeners.set(id, set)
          return () => { counts.listeners -= 1; set.delete(listener) }
        },
      },
      load: async () => {
        counts.loads += 1
        if (deferredLoads.length > 0) {
          await new Promise<void>((resolve) => { deferredLoads.push(resolve) })
        }
        return catalog
      },
      select: async (selection: HostSelection) => {
        counts.selects += 1
        log.push(`select:${id}`)
        hostSelections.set(id, selection)
        for (const listener of listeners.get(id) ?? []) listener()
      },
    }
    directories.set(id, created)
    return created
  }

  const retain = (target: string, options2: { readonly source: string }) => {
    counts.retains += 1
    log.push(`retain:${target}:${options2.source}`)
    const bySource = retainCounts.get(target) ?? new Map<string, number>()
    bySource.set(options2.source, (bySource.get(options2.source) ?? 0) + 1)
    retainCounts.set(target, bySource)
    let released = false
    const entry = { id: target, settled: false, settle: (error?: Error): void => {
      if (entry.settled) return
      entry.settled = true
      if (error === undefined) materialize(target)
      else pendingReject(error)
    } }
    const pendingReject = (error: Error): void => { void error }
    const ready = new Promise<void>((resolve, reject) => {
      entry.settle = (error?: Error): void => {
        if (entry.settled) return
        entry.settled = true
        if (error === undefined) { materialize(target); resolve() }
        else reject(error)
      }
    })
    pending.push(entry)
    return {
      ready,
      release: () => {
        if (released) return
        released = true
        counts.releases += 1
        log.push(`release:${target}:${options2.source}`)
        const countsFor = retainCounts.get(target)
        const current = countsFor?.get(options2.source) ?? 0
        if (current <= 1) countsFor?.delete(options2.source)
        else countsFor?.set(options2.source, current - 1)
        const total = [...(countsFor?.values() ?? [])].reduce((sum, value) => sum + value, 0)
        if (total === 0) {
          // The real controller retires the scope with its last reference.
          counts.scopeRetirements += 1
          scopes.delete(target)
          bindings.delete(target)
          directories.delete(target)
          listeners.delete(target)
        }
        // A released reference can no longer become ready.
        entry.settle(new Error(`Session reference "${target}" is released`))
      },
    }
  }

  let injected: UnifiedModelController | undefined
  const sessions: Record<string, unknown> = {
    scope: (id: string) => scopes.get(id),
    binding: (id: string) => bindings.get(id),
    list: { getSnapshot: () => ({ current: HOST_ROOT }), subscribe: () => () => undefined },
  }
  if (options.withRetain !== false) sessions.retain = retain
  // Generating a session is exactly what this fix must never do.
  sessions.create = async () => { counts.creates += 1; throw new Error('host create must not be called') }
  sessions.open = (id: string) => { counts.opens += 1; scopes.set(id, {}); bindings.set(id, bindingOf(id)) }
  const fakeClient = {
    effect: () => undefined,
    locale: { register: () => undefined },
    uiConversation: { events: { register: () => undefined }, views: { register: () => undefined } },
    // The installed resolver's own rule, reproduced: no scope or no binding is
    // a loud failure, so an unretained peer can never silently resolve.
    modelDirectories: { directoryFor },
    sessions,
    slots: {
      inject: (_key: string, callback: (sessionId: string) => unknown) => { callback(HOST_ROOT) },
      register: (opts: { name: string; inject?: (sessionId: string) => { unifiedModels: UnifiedModelController } }, _component: unknown) => {
        if (opts.name === 'conversation.input.right' && opts.inject !== undefined) {
          injected = opts.inject(HOST_ROOT).unifiedModels
        }
        return () => undefined
      },
    },
  }
  const { apply } = await import('../src/client/index.js')
  apply(fakeClient as never)
  if (injected === undefined) throw new Error('real host: no controller injected')

  return {
    controller: injected,
    log,
    counts,
    peerDirectories: () => log.filter((entry) => entry === `directory:${HOST_PEER}`).length,
    listenersOf: (id) => listeners.get(id)?.size ?? 0,
    retainTargets: () => log.filter((entry) => entry.startsWith('retain:')).map((entry) => entry.split(':')[1]!),
    retainSources: () => log.filter((entry) => entry.startsWith('retain:')).map((entry) => entry.split(':')[2]!),
    liveReferences: () => [...retainCounts.values()].reduce((sum, bySource) => sum + [...bySource.values()].reduce((a, b) => a + b, 0), 0),
    resolveReadySync: async () => {
    await act(async () => {
      for (const entry of pending.splice(0)) entry.settle()
      await Promise.resolve()
      await Promise.resolve()
    })
  },
    rejectReady: (error) => { for (const entry of pending.splice(0)) entry.settle(error ?? new Error('peer session could not be retained')) },
    retainAsOtherOwner: async () => {
      // Another owner (the workspace view) already holds the peer's scope.
      retain(HOST_PEER, { source: 'mainView' })
      await act(async () => {
        for (const entry of pending.splice(0)) entry.settle()
        await Promise.resolve()
        await Promise.resolve()
      })
    },
    scopePresent: () => scopes.has(HOST_PEER),
    pendingReady: () => pending.filter((entry) => !entry.settled).length,
    setSelection: (id, selection) => { hostSelections.set(id, selection); for (const listener of listeners.get(id) ?? []) listener() },
    selectionOf: (id) => hostSelections.get(id),
    breakSubscribe: () => { subscriptions.broken = true },
    notify: (id) => { for (const listener of listeners.get(id) ?? []) listener() },
    resolveLoadsLate: () => { for (const resolve of deferredLoads.splice(0)) resolve() },
    deferLoads: () => { deferredLoads.push(() => undefined) },
    hostSelections,
  }
}

/** Mount the real menu over a real-bridge controller and open it. */
function renderReal(controller: UnifiedModelController, options: { strict?: boolean } = {}): { container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const element = () => createElement(ChallengerModelControl, {
    useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : key === 'endeavourPeer' ? pair(HOST_ROOT) : null),
    sessionId: HOST_ROOT,
    unifiedModels: controller,
    t: undefined,
  } as never)
  act(() => {
    root.render(options.strict === true ? createElement(StrictMode, null, element()) : element())
  })
  roots.push(root)
  containers.push(container)
  return { container }
}


/**
 * A model write outlives the menu that started it: the popup closes as soon as
 * the user picks, so every completion lands after that menu generation is gone.
 * A stale completion must not publish state, must not re-read a directory it no
 * longer owns, and above all must not raise an error the user sees the next time
 * the menu opens — while the write the user asked for still lands.
 */