/**
 * Peer navigation tabs for the persistent pair.
 *
 * The tab of the CURRENT session is driven solely by that session's
 * `endeavourPeer` projection: an Endeavour root shows a `Challenger` tab, the
 * paired Challenger shows an `Endeavour` tab, and an unpaired or corrupt
 * session shows none. A trusted click resets the local view to Chat and then
 * opens the exact counterpart through the Workspace view owner. The whole
 * path is ordinary-session navigation: no addressed-child APIs and no
 * delegation metadata are involved.
 */

import { useLayoutEffect, useRef } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { validatePeerState, type PeerRole, type PeerState } from '../peer.js'
import { peerView } from '../peer-projection.js'
import { en } from './locales.js'

/** Observable projection face (as returned by `binding.session.projections.faceOf`). */
export interface PeerProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** The tab target derived from one session's peer projection. */
export interface PeerTabTarget {
  readonly role: PeerRole
  /** The other ordinary session of the pair (the navigation destination). */
  readonly counterpartId: string
}

/** Transient user activation check (absent in test/SSR environments). */
export function hasTransientUserActivation(): boolean {
  const activation = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation
  return activation?.isActive === true
}

/** Resolve the tab target for one session from its `endeavourPeer` value. */
export function peerTabTarget(sessionId: string | undefined, peer: unknown): PeerTabTarget | undefined {
  const state = (peer ?? null) as PeerState | null
  // A tab exists only for an exactly valid pair; a corrupt or half-written
  // checkpoint never navigates.
  if (state === null || validatePeerState(state).length > 0) return undefined
  const view = peerView(state, sessionId ?? '')
  if (view === null) return undefined
  return { role: view.role, counterpartId: view.counterpartId }
}

/** Dependencies for the dynamic registration. */
export interface PeerTabTargets {
  readonly currentSession: () => string | undefined
  readonly subscribeCurrent: (listener: () => void) => () => void
  /** The `endeavourPeer` face of one session, when its binding exists. */
  readonly peerFace: (sessionId: string, key: string) => PeerProjectionFace | undefined
  /** Register the entry for one role; the callback unregisters it. */
  readonly register: (role: PeerRole) => () => void
}

/**
 * Peer-activity activation targets: when the current session belongs to a valid
 * durable pair, its plugin-owned activity target must be ACTIVE so the shell
 * classifies the session as having Conversation content.
 */
export interface PeerActivityTargets {
  readonly currentSession: () => string | undefined
  readonly subscribeCurrent: (listener: () => void) => () => void
  readonly peerFace: (sessionId: string, key: string) => PeerProjectionFace | undefined
  /** Activate the plugin-owned activity target for one session. */
  readonly activate: (sessionId: string) => void
}

/**
 * Activate the peer activity target for the current session while it belongs to
 * a valid pair (either role), ONCE per session. The target owns a registered
 * view definition, so activation publishes the conversation snapshot and the
 * native header/View strip renders even though the session has no turns.
 * Idempotent across re-mounts, session switches and projection updates; client
 * view state only (no durable event, no prompt, no model request).
 */
export function reconcilePeerActivity(targets: PeerActivityTargets): () => void {
  let subscribed: string | undefined
  let disposeFace: (() => void) | undefined
  let activated: string | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempts = 0

  const clearRetry = (): void => {
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
  }

  const refresh = (): void => {
    const sessionId = targets.currentSession()
    if (subscribed !== sessionId) {
      clearRetry()
      attempts = 0
      disposeFace?.()
      disposeFace = undefined
      subscribed = sessionId
      if (sessionId !== undefined) {
        const face = targets.peerFace(sessionId, 'endeavourPeer')
        if (face !== undefined) disposeFace = face.subscribe(refresh)
      }
    }
    if (sessionId === undefined || sessionId === activated) return
    const peer = targets.peerFace(sessionId, 'endeavourPeer')?.getSnapshot()
    if (peerTabTarget(sessionId, peer) === undefined) {
      // The projection face may bind right after the shell mounts; retry a
      // bounded number of times instead of waiting for a session switch.
      if (attempts < 12 && sessionId === targets.currentSession()) {
        attempts += 1
        clearRetry()
        retry = setTimeout(refresh, 250)
      }
      return
    }
    clearRetry()
    activated = sessionId
    targets.activate(sessionId)
  }

  const disposeCurrent = targets.subscribeCurrent(refresh)
  refresh()
  return () => {
    clearRetry()
    disposeCurrent()
    disposeFace?.()
  }
}

/**
 * Keep exactly one peer tab registered while the current session belongs to a
 * valid pair; role changes switch the entry (label and destination) and every
 * other case unregisters it. Idempotent under repeated notifications.
 */
export function reconcilePeerTab(targets: PeerTabTargets): () => void {
  let disposeEntry: (() => void) | undefined
  let disposeFace: (() => void) | undefined
  let subscribed: string | undefined
  let registered: PeerRole | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let attempts = 0

  const clearRetry = (): void => {
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
  }

  const refresh = (): void => {
    const sessionId = targets.currentSession()
    if (subscribed !== sessionId) {
      clearRetry()
      attempts = 0
      disposeFace?.()
      disposeFace = undefined
      subscribed = sessionId
      if (sessionId !== undefined) {
        const face = targets.peerFace(sessionId, 'endeavourPeer')
        if (face !== undefined) disposeFace = face.subscribe(refresh)
      }
    }
    const peer = sessionId === undefined ? undefined : targets.peerFace(sessionId, 'endeavourPeer')?.getSnapshot()
    const target = peerTabTarget(sessionId, peer)
    const role = target?.role
    if (role === undefined) {
      disposeEntry?.()
      disposeEntry = undefined
      registered = undefined
      // The projection face can bind after the shell mounts. Retry briefly so
      // a slow hydration does not permanently hide the counterpart tab.
      if (attempts < 12 && sessionId === targets.currentSession()) {
        attempts += 1
        clearRetry()
        retry = setTimeout(refresh, 250)
      }
      return
    }
    clearRetry()
    if (role !== registered) {
      disposeEntry?.()
      disposeEntry = undefined
      disposeEntry = targets.register(role)
      registered = role
    }
  }

  const disposeCurrent = targets.subscribeCurrent(refresh)
  refresh()
  return () => {
    clearRetry()
    disposeCurrent()
    disposeFace?.()
    disposeEntry?.()
  }
}

/** Navigation dependencies of an explicit tab click. */
export interface PeerTabNavigation {
  readonly resetChat: (sessionId: string) => void
  readonly peer: unknown
  /** Open the exact counterpart ordinary session. */
  readonly openCounterpart: (sessionId: string) => void
  /** False for replay/HMR mounts, true only for a real user activation. */
  readonly transientActivation: boolean
}

/**
 * Explicit selection: Chat first (so a return never re-opens the peer), then
 * the exact counterpart through official session navigation.
 */
export function openPeerTab(sessionId: string | undefined, navigation: PeerTabNavigation): boolean {
  if (sessionId === undefined) return false
  navigation.resetChat(sessionId)
  if (!navigation.transientActivation) return false
  const target = peerTabTarget(sessionId, navigation.peer)
  if (target === undefined) return false
  navigation.openCounterpart(target.counterpartId)
  return true
}

/** Minimal slot registry surface used for registration. */
export interface PeerTabSlots {
  inject(name: string, callback: () => void): void
  register(options: PeerTabEntryOptions, component: unknown): () => void
}

/** Options of the registered view entry (id and label depend on the role). */
export interface PeerTabEntryOptions {
  readonly name: 'conversation.view'
  readonly id: 'endeavour-challenger-tab' | 'endeavour-endtab'
  readonly order: 20
  readonly locale: string
  readonly label: () => string
  readonly inject: (sessionId: string) => { readonly peerTab: PeerTabBridge }
}

/** Bridge handed to the mounted view. */
export interface PeerTabBridge {
  readonly select: (openView?: (view: string, focus: string) => void) => boolean
}

/** Register the role's tab entry; `selectFor` runs only on an explicit click. */
export function registerPeerTabEntry(
  slots: PeerTabSlots,
  role: PeerRole,
  selectFor: (sessionId: string, openView?: (view: string, focus: string) => void) => boolean,
): () => void {
  return slots.register({
    name: 'conversation.view',
    id: role === 'endeavour' ? 'endeavour-challenger-tab' : 'endeavour-endtab',
    order: 20,
    locale: 'endeavour',
    label: () => (role === 'endeavour' ? en['view.challenger'] : en['view.endeavour']),
    inject: (sessionId: string) => ({ peerTab: { select: (openView) => selectFor(sessionId, openView) } }),
  }, PeerTabView)
}

/** Props of the navigation-only view. */
export type PeerTabViewProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'endeavour'>
  & { readonly peerTab?: PeerTabBridge }

/**
 * Navigation-only view: one mount performs the explicit selection (Chat reset
 * plus a single counterpart open). A ref guard keeps StrictMode/HMR double
 * effects from opening twice, and replay mounts never navigate.
 */
export function PeerTabView(props: PeerTabViewProps): React.ReactElement | null {
  const ran = useRef(false)
  const openView = (props as { readonly openView?: (view: string, focus: string) => void }).openView
  useLayoutEffect(() => {
    if (ran.current) return
    ran.current = true
    props.peerTab?.select(openView)
  }, [])
  return null
}
