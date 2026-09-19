/**
 * Unified composer model control.
 *
 * One icon-only sliders button mirrors and writes BOTH ordinary sessions of a
 * durable pair through the official ModelDirectory each of them owns:
 * the Endeavour session the control is rendered in, and its paired Challenger.
 * There is no other model control in the composer: the native seat is hidden by
 * CSS only while this control is actually rendered.
 *
 * Every read, subscription, catalog load and write goes to the target role's own
 * `modelDirectories.directoryFor(sessionId)`; the two roles never share mutable
 * selection state, and neither the catalogs nor the peer sessions are touched.
 */

import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
import { validatePeerState, type PeerState } from '../peer.js'
import { peerView } from '../peer-projection.js'
import { copyFrom } from './PlanCard.js'
import {
  builderControlDisabled,
  effortLabelFor,
  findCatalogModel,
  modelHasThinking,
  thinkingOptions,
  type BuilderRouteVisibility,
} from './builder-route-model.js'
import { CLASS } from './styles.js'
import type { EndeavourKey } from './locales.js'

/** The two ordinary sessions this control configures. */
export type UnifiedRole = 'endeavour' | 'challenger'

/** The roles in menu order. */
export const UNIFIED_ROLES: readonly UnifiedRole[] = ['endeavour', 'challenger']

/** One ordinary-session model selection. */
export interface UnifiedSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One role's directory bridge: read, subscribe, load and write that session. */
export interface UnifiedRoleController {
  /** True when the role's ModelDirectory currently resolves. */
  readonly available: () => boolean
  readonly readSelection: () => UnifiedSelection | undefined
  readonly subscribeSelection: (listener: () => void) => () => void
  readonly loadCatalog: () => Promise<unknown>
  readonly select: (provider: string, model: string, reasoningEffort: string | undefined) => Promise<void>
}

/** Both role bridges, resolved independently by the client integration. */
export interface UnifiedModelController {
  readonly roles: Readonly<Record<UnifiedRole, UnifiedRoleController>>
  /**
   * Persistent admission for this session, owned by the per-session controller
   * (not by a React ref, so a remount keeps it). Called with the live
   * `agentPreset` value on every render: `true` once this session has been seen
   * with an explicit `endeavour` preset AND a validated Endeavour-side peer
   * view, and only revoked by an explicit non-`endeavour` preset.
   */
  readonly admit?: (preset: string | undefined) => boolean
}

/**
 * Catalog face the control renders from. Structurally identical to the official
 * ModelDirectory state the native ModelSelect consumes (`groups`), so the bridge
 * hands the directory value over without any translation.
 */
export interface UnifiedCatalog {
  readonly groups: readonly {
    readonly id: string
    readonly models: readonly ModelCatalogModel[]
  }[]
}

/** Slot props: session seats, the locale and the two-role bridge. */
export type UnifiedModelControlProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'endeavour'>
  & { readonly unifiedModels: UnifiedModelController }

type CatalogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: UnifiedCatalog }
  | { readonly kind: 'error'; readonly message: string }

type Pane =
  | { readonly kind: 'root' }
  | { readonly kind: 'model'; readonly role: UnifiedRole }
  | { readonly kind: 'thinking'; readonly role: UnifiedRole }

interface MenuRow {
  readonly id: string
  readonly kind: 'section' | 'cell' | 'option' | 'group' | 'note' | 'retry'
  readonly label: string
  readonly value?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly role?: UnifiedRole
  readonly action?: () => void
}

const MEASURE_STYLE: React.CSSProperties = { position: 'fixed', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none' }

const emptyCatalog = (): Record<UnifiedRole, CatalogState> => ({ endeavour: { kind: 'idle' }, challenger: { kind: 'idle' } })

/** Endeavour section mark: the planning clipboard. */
function PlanMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-endeavour-role-icon="plan" className={CLASS.roleGlyph}>
      <rect x="3.4" y="2.6" width="9.2" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.2 2.6V1.8h3.6v0.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.9 6.6l1.1 1.1 2.2-2.3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.9 10.4h4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Challenger section mark: the run triangle. */
function RunMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-endeavour-role-icon="execute" className={CLASS.roleGlyph}>
      <path d="M5.4 3.2 12.4 8l-7 4.8z" fill="currentColor" />
    </svg>
  )
}

/** Trigger mark: sliders, the two-role settings affordance. */
function SlidersMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" data-endeavour-unified-icon="sliders" className={CLASS.roleGlyph}>
      <path d="M2.6 5.4h10.8M2.6 10.6h10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6.2" cy="5.4" r="1.8" fill="currentColor" />
      <circle cx="9.8" cy="10.6" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** Peer role of the current session, when it belongs to a valid pair. */
function peerRoleOfProjection(peer: unknown, sessionId: string | undefined): 'endeavour' | 'challenger' | undefined {
  if (sessionId === undefined) return undefined
  const state = (peer ?? null) as PeerState | null
  // Only an exactly valid pair grants the control; forged or half-written
  // checkpoints render nothing.
  if (state === null || validatePeerState(state).length > 0) return undefined
  return peerView(state, sessionId)?.role
}

/**
 * One role's post-commit snapshot: whether its directory probed available and
 * the mirrored selection. Rendering reads this value and nothing else.
 */
interface RoleView {
  readonly available: boolean
  readonly selection?: UnifiedSelection
}

const emptyViews: Record<UnifiedRole, RoleView> = { endeavour: { available: false }, challenger: { available: false } }

/** Semantic equality over the mirrored selection fields. */
export function sameSelection(left: UnifiedSelection | undefined, right: UnifiedSelection | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

function sameRoleView(left: RoleView, right: RoleView): boolean {
  return left.available === right.available && sameSelection(left.selection, right.selection)
}

function sameViews(left: Record<UnifiedRole, RoleView>, right: Record<UnifiedRole, RoleView>): boolean {
  return UNIFIED_ROLES.every((role) => sameRoleView(left[role], right[role]))
}

/** Fallback placement for the menu-only error surface, in CSS pixels. */
const MENU_WIDTH = 320
const MENU_MIN_HEIGHT = 96

/** Role operations the menu calls synchronously while it mounts. */
type MenuOperation = 'readSelection' | 'available' | 'subscribeSelection'

/**
 * Diagnostic bound: the fallback shows at most this many characters of the
 * caught error, so a message can never turn into a wall of text.
 */
export const MENU_DETAIL_MAX = 160

/**
 * Tag a synchronous role operation so an exception reaching the menu boundary
 * names the call that failed. The original message is preserved.
 */
function roleOperation<T>(role: UnifiedRole, operation: MenuOperation, run: () => T): T {
  try {
    return run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${role}.${operation}: ${message}`)
  }
}

/**
 * Display-safe diagnostic for the menu fallback: error name and message only,
 * whitespace collapsed, control characters removed and the length capped. A
 * stack, `cause`, or any object serialization never reaches the UI, and an
 * unusable error yields `undefined` so the caller can keep the generic copy.
 */
export function safeDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const name = typeof error.name === 'string' && error.name !== 'Error' ? `${error.name}: ` : ''
  const raw = `${name}${typeof error.message === 'string' ? error.message : ''}`
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean === '') return undefined
  return clean.length > MENU_DETAIL_MAX ? `${clean.slice(0, MENU_DETAIL_MAX - 1)}…` : clean
}

/**
 * Stable admitted shell: admission, the trigger and the open flag only. It never
 * touches a ModelDirectory, catalog or role controller, so no directory failure
 * can remove the trigger or the marker that hides the host's native selector.
 */
export function UnifiedModelControl(props: UnifiedModelControlProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const agentPreset = typeof useProjection === 'function' ? (useProjection('agentPreset') as string | undefined) : undefined
  const peer = typeof useProjection === 'function' ? useProjection('endeavourPeer') : undefined
  const plan = typeof useProjection === 'function'
    ? (useProjection('endeavourPlan') as { readonly terminal?: unknown } | null | undefined)
    : undefined
  const sessionId = (props as { readonly sessionId?: string }).sessionId
  const visibility: BuilderRouteVisibility = {
    agentPreset,
    planActive: plan !== undefined && plan !== null && plan.terminal === undefined,
    running: false,
  }
  // Visibility is explicit: the paired ENDEAVOUR side of a valid pair. The
  // trigger does NOT depend on the paired directory resolving — that failure is
  // transient (the resolver throws for a session without a live scope/binding)
  // and unmounting here would drop the native-seat hiding marker and expose the
  // host selector. An unavailable role is reported inside the menu instead. A
  // plan or a running turn disables the control instead of hiding it, so an
  // active plan keeps every route frozen.
  //
  // Admission is PERSISTENT and owned by the per-session controller: it survives
  // projection jitter AND component remounts, because it lives in the cached
  // bridge rather than in this component. It is granted only when this session
  // simultaneously shows an explicit `endeavour` preset and a validated
  // Endeavour-side peer view, and revoked only by an explicit other preset — so
  // an initially absent, invalid or Challenger-side session still renders
  // nothing. The live preset may still DISABLE an admitted (active-plan) control.
  const role = peerRoleOfProjection(peer, sessionId)
  const admitted = props.unifiedModels.admit === undefined
    ? undefined
    : sessionId === undefined
      ? false
      : props.unifiedModels.admit(agentPreset)
  const show = admitted === undefined
    ? role === 'endeavour' && builderControlDisabled({ ...visibility, planActive: false, running: false }) === undefined
    : admitted
  const disabledReason = show ? builderControlDisabled(visibility) : undefined

  const [open, setOpen] = useState(false)
  // Menu retry: a fresh key remounts the fallible subtree without touching
  // admission or the trigger.
  const [menuAttempt, setMenuAttempt] = useState(0)
  // Last rejected write, reported inside the menu. It lives in the stable shell
  // so closing and reopening the menu keeps reporting it, as before the split.
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)

  if (!show) return null
  return (
    <div ref={shellRef} className={CLASS.unifiedControl}>
      <button
        ref={chipRef}
        type="button"
        data-endeavour-unified-models=""
        className={CLASS.unifiedTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={copy('unified.trigger')}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? copy('unified.trigger')}
        onClick={() => { setOpen((value) => !value) }}
      >
        <SlidersMark />
      </button>
      {open ? createPortal(
        <MenuBoundary
          key={menuAttempt}
          copy={copy}
          triggerRef={chipRef}
          onRetry={() => { setMenuAttempt((value) => value + 1) }}
        >
          <UnifiedMenu
            roles={props.unifiedModels.roles}
            copy={copy}
            saveError={saveError}
            onSaveError={setSaveError}
            triggerRef={chipRef}
            shellRef={shellRef}
            onClose={(restoreFocus) => {
              setOpen(false)
              if (restoreFocus) chipRef.current?.focus()
            }}
          />
        </MenuBoundary>,
        document.body,
      ) : null}
    </div>
  )
}

interface MenuBoundaryProps {
  readonly children: React.ReactNode
  readonly copy: (key: EndeavourKey, params?: Record<string, string | number>) => string
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly onRetry: () => void
}

/**
 * Menu-only failure containment: an unexpected exception from any role read,
 * subscription, catalog or render keeps the trigger and the native-seat marker
 * mounted and offers a localized retry that remounts the subtree.
 */
class MenuBoundary extends Component<MenuBoundaryProps, { readonly failed: boolean; readonly detail?: string }> {
  override state: { readonly failed: boolean; readonly detail?: string } = { failed: false }

  static getDerivedStateFromError(error: unknown): { readonly failed: boolean; readonly detail?: string } {
    const detail = safeDiagnostic(error)
    return detail === undefined ? { failed: true } : { failed: true, detail }
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children
    const rect = this.props.triggerRef.current?.getBoundingClientRect()
    const style: React.CSSProperties = rect === undefined
      ? { position: 'fixed', left: 8, top: 8 }
      : { position: 'fixed', left: Math.max(8, rect.right - MENU_WIDTH), top: Math.max(8, rect.top - 8 - MENU_MIN_HEIGHT) }
    return (
      <div
        role="menu"
        aria-label={this.props.copy('unified.trigger')}
        className={CLASS.menu}
        data-endeavour-menu-error=""
        style={style}
      >
        <div className={CLASS.menuNote}>
          <span>{this.props.copy('unified.error')}</span>
          {this.state.detail === undefined
            ? null
            : <span data-endeavour-menu-error-detail="">{this.props.copy('unified.errorDetail', { detail: this.state.detail })}</span>}
          <button
            type="button"
            className={CLASS.menuRetry}
            data-endeavour-menu-retry=""
            onClick={() => { this.setState({ failed: false }); this.props.onRetry() }}
          >
            {this.props.copy('builder.retry')}
          </button>
        </div>
      </div>
    )
  }
}

interface UnifiedMenuProps {
  readonly roles: Readonly<Record<UnifiedRole, UnifiedRoleController>>
  readonly copy: (key: EndeavourKey, params?: Record<string, string | number>) => string
  readonly saveError: string | undefined
  readonly onSaveError: (message: string | undefined) => void
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly shellRef: React.RefObject<HTMLDivElement | null>
  readonly onClose: (restoreFocus: boolean) => void
}

/**
 * Fallible menu subtree: every role availability/read/subscription/catalog/select
 * operation lives here, below the menu-only boundary. Availability and selection
 * are acquired AFTER COMMIT into a local per-role snapshot that rendering reads;
 * no role controller runs while this component renders, because a lazy directory
 * probe can publish composer/session changes and loop the slot parent. Focus
 * stays on the trigger (outside this subtree), so keyboard handling is bound to
 * the document while the menu is mounted.
 */
function UnifiedMenu(props: UnifiedMenuProps): React.ReactElement {
  const { roles, copy } = props
  // Rendering is pure: the menu reads ONLY this post-commit snapshot. Probing a
  // role can lazily create its directory, which may publish composer/session
  // changes and re-render the slot parent synchronously — doing that while
  // rendering nests an update inside a render and loops (React invariant 185).
  const [views, setViews] = useState<Record<UnifiedRole, RoleView>>(emptyViews)
  const [probed, setProbed] = useState(false)
  const [catalogs, setCatalogs] = useState<Record<UnifiedRole, CatalogState>>(emptyCatalog)
  const [pane, setPane] = useState<Pane>({ kind: 'root' })
  const [busy, setBusy] = useState(false)
  // Bumped by a role retry: it re-runs the availability read and the rows memo.
  const [retryToken, setRetryToken] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  // A subscription failure happens in an effect, which React does not route to
  // an error boundary; it is captured here and re-thrown during render so the
  // menu boundary handles it with the tag intact.
  const [setupError, setSetupError] = useState<unknown>(undefined)
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const loadCatalog = useCallback((target: UnifiedRole): void => {
    setCatalogs((current) => ({ ...current, [target]: { kind: 'loading' } }))
    void roles[target].loadCatalog().then(
      (result) => { setCatalogs((current) => ({ ...current, [target]: { kind: 'ready', catalog: result as UnifiedCatalog } })) },
      (error: unknown) => {
        const message = String((error as Error).message ?? error)
        setCatalogs((current) => ({ ...current, [target]: { kind: 'error', message } }))
      },
    )
  }, [roles])

  /**
   * Publish one role's probed state, reusing the previous object when nothing
   * semantic changed: a subscription that fires synchronously, repeatedly or
   * with an identical selection must never cause another render.
   */
  const publish = useCallback((target: UnifiedRole, update: RoleView): void => {
    setViews((current) => (sameRoleView(current[target], update) ? current : { ...current, [target]: update }))
  }, [])

  // Post-commit acquisition: probe availability, then read the selection, then
  // subscribe — never while rendering. Effect-time exceptions are stored and
  // thrown on the next render so MenuBoundary handles them with the tag intact.
  useEffect(() => {
    const disposers: (() => void)[] = []
    // One idempotent cleanup owns every subscription this run created. It is
    // invoked immediately when setup fails part-way, and returned to React so a
    // dependency rerun or unmount tears the same set down exactly once. A
    // throwing disposer is contained: the original setup error is what reaches
    // the boundary and the diagnostic.
    let closed = false
    const cleanup = (): void => {
      if (closed) return
      closed = true
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A failing disposer must not mask the role-operation error.
        }
      }
    }
    const next: Record<UnifiedRole, RoleView> = { ...emptyViews }
    try {
      for (const target of UNIFIED_ROLES) {
        if (!roleOperation(target, 'available', () => roles[target].available())) continue
        const selection = roleOperation(target, 'readSelection', () => roles[target].readSelection())
        next[target] = selection === undefined ? { available: true } : { available: true, selection }
        disposers.push(roleOperation(target, 'subscribeSelection', () => roles[target].subscribeSelection(() => {
          // Re-probe and read after commit, then publish a deduplicated
          // snapshot: a notification may also mean the role went away.
          try {
            if (!roleOperation(target, 'available', () => roles[target].available())) {
              publish(target, { available: false })
              return
            }
            const latest = roleOperation(target, 'readSelection', () => roles[target].readSelection())
            publish(target, latest === undefined ? { available: true } : { available: true, selection: latest })
          } catch (error) {
            setSetupError(error)
          }
        })))
      }
    } catch (error) {
      // Transactional: undo the partial setup before surfacing the failure.
      cleanup()
      setSetupError(error)
      return cleanup
    }
    setViews((current) => (sameViews(current, next) ? current : next))
    setProbed(true)
    return cleanup
  }, [roles, retryToken, publish])

  if (setupError !== undefined) throw setupError

  /** Retry re-probes ONE role after commit; its catalog follows availability. */
  const retryRole = (target: UnifiedRole): void => {
    setRetryToken((value) => value + 1)
    if (views[target].available) loadCatalog(target)
  }

  useEffect(() => {
    // Catalogs load only for roles that probed available, each from its own
    // directory and exactly once per open (a resolved role is skipped by the
    // catalog-state guard).
    if (!probed) return
    for (const target of UNIFIED_ROLES) {
      if (!views[target].available || catalogs[target].kind !== 'idle') continue
      loadCatalog(target)
    }
  }, [probed, views, catalogs, loadCatalog])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      const insideShell = props.shellRef.current?.contains(target) ?? false
      const insideMenu = menuRef.current?.contains(target) ?? false
      if (!insideShell && !insideMenu) props.onClose(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const catalogValue = (target: UnifiedRole): UnifiedCatalog | undefined => {
    const state = catalogs[target]
    return state.kind === 'ready' ? state.catalog : undefined
  }
  const modelOf = useCallback((target: UnifiedRole): ModelCatalogModel | undefined => {
    const selection = views[target].selection
    return findCatalogModel(catalogValue(target), selection?.provider, selection?.model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogs, views])

  const modelLabelOf = (target: UnifiedRole): string | undefined => {
    const selection = views[target].selection
    if (selection === undefined) return undefined
    return modelOf(target)?.name ?? selection.model
  }
  const thinkingLabelOf = (target: UnifiedRole): string | undefined => {
    const selection = views[target].selection
    if (selection === undefined) return undefined
    const model = modelOf(target)
    return modelHasThinking(model)
      ? (effortLabelFor(model, selection.reasoningEffort) ?? copy('builder.default'))
      : copy('builder.notAvailable')
  }
  const canDrillThinking = (target: UnifiedRole): boolean => {
    const selection = views[target].selection
    return selection !== undefined && modelHasThinking(modelOf(target))
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (pane.kind === 'root') {
      const list: MenuRow[] = []
      for (const target of UNIFIED_ROLES) {
        const roleName = copy(target === 'endeavour' ? 'unified.endeavour' : 'unified.challenger')
        // Post-commit snapshot only: never a role controller call during render.
        const available = probed && views[target].available
        list.push({ id: `section:${target}`, kind: 'section', label: roleName })
        if (probed && !views[target].available) {
          // A scoped, recoverable state: the section and its rows stay visible,
          // only this role is degraded, and retry re-resolves just its directory.
          list.push({
            id: `retry:${target}`,
            kind: 'retry',
            label: copy('unified.unavailable', { role: roleName }),
            role: target,
            action: () => { retryRole(target) },
          })
        }
        const state = catalogs[target]
        list.push({
          id: `model:${target}`,
          kind: 'cell',
          label: copy('builder.model'),
          value: !probed
            ? copy('builder.loading')
            : available
              ? (modelLabelOf(target) ?? (state.kind === 'error' ? copy('builder.error') : copy('builder.loading')))
              : copy('builder.notAvailable'),
          disabled: !available,
          action: () => { setPane({ kind: 'model', role: target }) },
        })
        list.push({
          id: `thinking:${target}`,
          kind: 'cell',
          label: copy('builder.effort'),
          value: !probed
            ? copy('builder.loading')
            : available
              ? (thinkingLabelOf(target) ?? (state.kind === 'error' ? copy('builder.error') : copy('builder.loading')))
              : copy('builder.notAvailable'),
          disabled: !available || !canDrillThinking(target),
          action: () => { if (canDrillThinking(target)) setPane({ kind: 'thinking', role: target }) },
        })
      }
      return list
    }
    const target = pane.role
    if (pane.kind === 'thinking') {
      const selection = views[target].selection
      return thinkingOptions(modelOf(target), selection?.reasoningEffort).map<MenuRow>((option) => ({
        id: `thinking:${target}:${option.effort ?? 'default'}`,
        kind: 'option',
        label: option.effort === undefined ? copy('builder.default') : option.label,
        selected: option.selected,
        action: () => { chooseEffort(target, option.effort) },
      }))
    }
    const state = catalogs[target]
    const list: MenuRow[] = []
    if (state.kind === 'loading') list.push({ id: 'loading', kind: 'note', label: copy('builder.loading') })
    if (state.kind === 'error') list.push({ id: 'error', kind: 'note', label: copy('builder.error') })
    const catalog = catalogValue(target)
    if (catalog !== undefined) {
      const selection = views[target].selection
      for (const group of catalog.groups) {
        list.push({ id: `group:${group.id}`, kind: 'group', label: (group as { readonly name?: string }).name ?? group.id })
        for (const model of group.models) {
          list.push({
            id: `model:${target}:${group.id}:${model.id}`,
            kind: 'option',
            label: model.name,
            selected: selection?.provider === group.id && selection.model === model.id,
            action: () => { chooseModel(target, group.id, model.id) },
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane, catalogs, views, probed, retryToken])

  const enabledRows = rows.filter((row) => row.kind !== 'section' && row.kind !== 'group' && row.kind !== 'note' && row.disabled !== true)
  const activeRow = enabledRows[Math.min(activeIndex, Math.max(enabledRows.length - 1, 0))]

  useEffect(() => {
    const selectedIndex = enabledRows.findIndex((row) => row.selected === true)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.kind, catalogKindKey(catalogs)])

  const place = useCallback((): void => {
    const menu = menuRef.current
    const trigger = props.triggerRef.current
    if (menu === null || trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const above = rect.top - 8 - height
    const y = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8)
    setMenuPos((current) => (current !== null && current.left === x && current.top === y ? current : { position: 'fixed', left: x, top: y }))
  }, [props.triggerRef])

  useLayoutEffect(() => {
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [pane, catalogs, place])

  // Focus stays on the trigger, which lives outside this portal subtree, so the
  // keys are read from the document while the menu is mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (pane.kind !== 'root') { setPane({ kind: 'root' }); return }
        props.onClose(true)
        return
      }
      if (event.key === 'Tab') { event.preventDefault(); props.onClose(true); return }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (enabledRows.length === 0) return
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((index) => (index + delta + enabledRows.length) % enabledRows.length)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (activeRow?.action !== undefined) { event.preventDefault(); activeRow.action() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown)
    }
  })

  /** Write through the target role's directory, preserving the other role. */
  const select = (target: UnifiedRole, provider: string, model: string, effort: string | undefined): void => {
    setBusy(true)
    props.onSaveError(undefined)
    void roles[target].select(provider, model, effort).then(
      () => {
        setBusy(false)
        // A successful write refreshes only the written role, after commit.
        const latest = roleOperation(target, 'readSelection', () => roles[target].readSelection())
        publish(target, latest === undefined ? { available: true } : { available: true, selection: latest })
      },
      (error: unknown) => {
        setBusy(false)
        props.onSaveError(String((error as Error).message ?? error))
        // Re-read the rejected role after commit so its displayed selection
        // never keeps a value the directory refused; the other role is untouched.
        const latest = roleOperation(target, 'readSelection', () => roles[target].readSelection())
        publish(target, latest === undefined ? { available: true } : { available: true, selection: latest })
      },
    )
  }

  function chooseModel(target: UnifiedRole, provider: string, modelId: string): void {
    const model = findCatalogModel(catalogValue(target), provider, modelId)
    // Only THIS role's effort resets, to the model's own catalog default.
    select(target, provider, modelId, model?.reasoning?.defaultEffort)
    props.onClose(false)
  }
  function chooseEffort(target: UnifiedRole, effort: string | undefined): void {
    const selection = views[target].selection
    if (selection === undefined) return
    // The model of that role is preserved.
    select(target, selection.provider, selection.model, effort)
    props.onClose(false)
  }

  const paneRole: UnifiedRole | undefined = pane.kind === 'root' ? undefined : pane.role
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={copy('unified.trigger')}
      data-endeavour-unified-pane={pane.kind === 'root' ? 'root' : `${pane.kind}:${pane.role}`}
      className={CLASS.menu}
      style={menuPos ?? MEASURE_STYLE}
    >
      {paneRole === undefined ? null : (
        <div className={CLASS.menuTitle} role="presentation">
          {paneRole === 'endeavour' ? copy('unified.endeavour') : copy('unified.challenger')}
        </div>
      )}
      {rows.map((row) => {
        if (row.kind === 'section') {
          const target: UnifiedRole = row.id.endsWith('challenger') ? 'challenger' : 'endeavour'
          return (
            <div key={row.id} className={CLASS.menuSection} role="presentation" data-endeavour-section={target}>
              <span className={CLASS.menuSectionIcon} aria-hidden="true">
                {target === 'endeavour' ? <PlanMark /> : <RunMark />}
              </span>
              <span>{row.label}</span>
            </div>
          )
        }
        if (row.kind === 'group') return <div key={row.id} className={CLASS.menuGroup}>{row.label}</div>
        if (row.kind === 'note') {
          return (
            <div key={row.id} className={CLASS.menuNote}>
              <span>{row.label}</span>
              {row.id === 'error' ? <button type="button" className={CLASS.menuRetry} data-endeavour-retry={paneRole} onClick={() => { if (paneRole !== undefined) loadCatalog(paneRole) }}>{copy('builder.retry')}</button> : null}
            </div>
          )
        }
        const active = row === activeRow
        if (row.kind === 'retry') {
          return (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              data-endeavour-retry={row.role}
              onMouseEnter={() => { setActiveIndex(enabledRows.indexOf(row)) }}
              onClick={() => { row.action?.() }}
              className={active ? CLASS.menuOptionActive : CLASS.menuOption}
            >
              <span className={CLASS.menuOptionCopy}>
                <span className={CLASS.menuOptionName}>{row.label}</span>
              </span>
              <span className={CLASS.menuCheck}>{copy('builder.retry')}</span>
            </button>
          )
        }
        if (row.kind === 'cell') {
          return (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              disabled={row.disabled === true}
              aria-haspopup="menu"
              onMouseEnter={() => { setActiveIndex(enabledRows.indexOf(row)) }}
              onClick={() => { row.action?.() }}
              className={active ? CLASS.menuCellActive : CLASS.menuCell}
            >
              <span className={CLASS.menuCellLabel}>{row.label}</span>
              <span className={CLASS.menuCellValue}>{row.value}</span>
              <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={CLASS.menuCellChevron}>
                <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )
        }
        return (
          <button
            key={row.id}
            type="button"
            role="menuitemradio"
            aria-checked={row.selected === true}
            disabled={row.disabled === true}
            onMouseEnter={() => { setActiveIndex(enabledRows.indexOf(row)) }}
            onClick={() => { row.action?.() }}
            className={active ? CLASS.menuOptionActive : CLASS.menuOption}
          >
            <span className={CLASS.menuOptionCopy}>
              <span className={CLASS.menuOptionName}>{row.label}</span>
            </span>
            <span className={CLASS.menuCheck}>
              {row.selected === true ? (
                <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : null}
            </span>
          </button>
        )
      })}
      {props.saveError === undefined ? null : <div className={CLASS.menuError}>{copy('builder.saveFailed')}</div>}
    </div>
  )
}

/** Stable key for the catalog state so the active-row effect re-runs on load. */
function catalogKindKey(catalogs: Record<UnifiedRole, CatalogState>): string {
  return UNIFIED_ROLES.map((role) => catalogs[role].kind).join(':')
}

/** Re-exported helper for tests: the catalog model metadata type. */
export type { ModelCatalogModel }
