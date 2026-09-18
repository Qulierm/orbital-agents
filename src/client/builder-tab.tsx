/**
 * Builder navigation tab.
 *
 * A `conversation.view` entry (order 20, label `Builder`) that appears only
 * while the CURRENT session is an Endeavour root whose durable `endeavourPlan`
 * projection carries a valid child address. Selecting the tab is pure
 * navigation: it resets the root's active view to Chat first, then opens the
 * EXISTING addressed continuable child through the same bridge as the dock's
 * Open Builder action. It never spawns, never writes settings, and never makes
 * a model call; when the child is missing it fails safely (no navigation).
 */

import { useLayoutEffect, useRef } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { en } from './locales.js'

/** A validated tab target read from the durable plan projection. */
export interface BuilderTabTarget {
  readonly parentSessionId: string
  readonly childSessionId: string
}

/** Observable projection face (as returned by `binding.session.projections.faceOf`). */
export interface ProjectionFace {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/**
 * Resolve the tab target for one session from the durable projection.
 * Valid only for an Endeavour root whose plan points at a non-empty child of
 * ITSELF: Standard chats, addressed children (rootSessionId !== sessionId),
 * blank roots, and corrupt/empty projections all yield `undefined`.
 */
export function builderTabTarget(
  sessionId: string | undefined,
  agentPreset: unknown,
  plan: unknown,
): BuilderTabTarget | undefined {
  if (sessionId === undefined || agentPreset !== 'endeavour') return undefined
  const state = plan as { rootSessionId?: unknown; childId?: unknown } | null | undefined
  if (state === null || state === undefined) return undefined
  if (typeof state.rootSessionId !== 'string' || state.rootSessionId !== sessionId) return undefined
  if (typeof state.childId !== 'string' || state.childId.length === 0) return undefined
  return { parentSessionId: sessionId, childSessionId: state.childId }
}

/** Dependencies the reconciliation needs (all official, injected for tests). */
export interface BuilderTabFaces {
  /** The currently selected session id. */
  readonly currentSession: () => string | undefined
  /** Subscribe to current-session identity changes. */
  readonly subscribeCurrent: (listener: () => void) => () => void
  /** A projection face for one session, when the binding exists. */
  readonly face: (sessionId: string, key: string) => ProjectionFace | undefined
  /** Register the view entry; the returned callback unregisters it. */
  readonly register: () => () => void
}

/**
 * Keep exactly one `conversation.view` entry registered while the current
 * session is a valid root. Idempotent under repeated face notifications,
 * re-subscribes on session switches, and disposes both the entry and the
 * face subscriptions.
 */
export function reconcileBuilderTab(faces: BuilderTabFaces): () => void {
  let disposeEntry: (() => void) | undefined
  let disposeFaces: (() => void) | undefined
  let subscribed: string | undefined

  const refresh = (): void => {
    const sessionId = faces.currentSession()
    if (subscribed !== sessionId) {
      disposeFaces?.()
      disposeFaces = undefined
      subscribed = sessionId
      if (sessionId !== undefined) {
        const unsubscribers = [faces.face(sessionId, 'agentPreset'), faces.face(sessionId, 'endeavourPlan')]
          .filter((face): face is ProjectionFace => face !== undefined)
          .map((face) => face.subscribe(refresh))
        disposeFaces = () => { for (const unsubscribe of unsubscribers) unsubscribe() }
      }
    }
    const preset = sessionId === undefined ? undefined : faces.face(sessionId, 'agentPreset')?.getSnapshot()
    const plan = sessionId === undefined ? undefined : faces.face(sessionId, 'endeavourPlan')?.getSnapshot()
    const valid = builderTabTarget(sessionId, preset, plan) !== undefined
    if (valid && disposeEntry === undefined) disposeEntry = faces.register()
    if (!valid && disposeEntry !== undefined) {
      disposeEntry()
      disposeEntry = undefined
    }
  }

  const disposeCurrent = faces.subscribeCurrent(refresh)
  refresh()
  return () => {
    disposeCurrent()
    disposeFaces?.()
    disposeEntry?.()
  }
}

/** Navigation dependencies of the explicit tab selection. */
export interface BuilderTabNavigation {
  /** Reset the root's active view to Chat through the official selector. */
  readonly resetChat: (sessionId: string) => void
  /** The plan projection snapshot for that session. */
  readonly readPlan: (sessionId: string) => unknown
  /** Open the addressed child through the shared Open Builder bridge. */
  readonly open: (address: BuilderTabTarget) => void
  /**
   * Whether the browser reports transient user activation (a real click).
   * Mounts caused by replay/restore/HMR are NOT user activations, so they only
   * reset Chat and never auto-open the child.
   */
  readonly transientActivation: boolean
}

/**
 * Explicit tab selection: restore Chat FIRST so a return to the root never
 * auto-navigates, then open the existing child exactly once — only for a real
 * user activation. A missing/corrupt projection or a replay mount resets Chat
 * and reports `false`; there is no guessed fallback navigation of our own.
 */
export function openBuilderTab(sessionId: string | undefined, navigation: BuilderTabNavigation): boolean {
  if (sessionId === undefined) return false
  navigation.resetChat(sessionId)
  if (!navigation.transientActivation) return false
  const target = builderTabTarget(sessionId, 'endeavour', navigation.readPlan(sessionId))
  if (target === undefined) return false
  navigation.open(target)
  return true
}

/** The view's official selector: selects a view and persists the preference. */
export type BuilderTabOpenView = (view: string, focus: string) => void

/** Transient user activation check (absent in test/SSR environments). */
export function hasTransientUserActivation(): boolean {
  const activation = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation
  return activation?.isActive === true
}

/** Minimal slot registry surface used for registration. */
export interface BuilderTabSlots {
  inject(name: string, callback: () => void): void
  register(options: BuilderTabEntryOptions, component: unknown): () => void
}

/** Options of the registered view entry. */
export interface BuilderTabEntryOptions {
  readonly name: 'conversation.view'
  readonly id: 'endeavour-builder'
  readonly order: 20
  readonly locale: string
  readonly label: () => string
  readonly inject: (sessionId: string) => { readonly builderTab: BuilderTabBridge }
}

/** Bridge handed to the mounted view. */
export interface BuilderTabBridge {
  readonly select: (openView?: BuilderTabOpenView) => boolean
}

/**
 * Register the view entry once. `openBuilderTab` runs only when the host mounts
 * the view for an explicit activation; the entry itself never navigates.
 */
export function registerBuilderTabEntry(
  slots: BuilderTabSlots,
  selectFor: (sessionId: string, openView?: BuilderTabOpenView) => boolean,
): () => void {
  return slots.register({
    name: 'conversation.view',
    id: 'endeavour-builder',
    order: 20,
    locale: 'endeavour',
    label: () => en['view.builder'],
    inject: (sessionId: string) => ({ builderTab: { select: (openView?: BuilderTabOpenView) => selectFor(sessionId, openView) } }),
  }, BuilderTabView)
}

/** Props of the navigation-only view. */
export type BuilderTabViewProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'endeavour'>
  & { readonly builderTab?: BuilderTabBridge }

/**
 * Navigation-only view: on its one mount it performs the explicit selection
 * (Chat reset + single addressed open). It renders nothing visible, so the
 * host immediately shows the child's ordinary Chat/Trajectory shell. A ref
 * guard keeps StrictMode/HMR double effects from opening twice.
 */
export function BuilderTabView(props: BuilderTabViewProps): React.ReactElement | null {
  const ran = useRef(false)
  const openView = (props as { readonly openView?: BuilderTabOpenView }).openView
  useLayoutEffect(() => {
    if (ran.current) return
    ran.current = true
    props.builderTab?.select(openView)
  }, [])
  return null
}
