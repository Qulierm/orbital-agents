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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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

/** One unified model control for a paired Endeavour chat. */
export function UnifiedModelControl(props: UnifiedModelControlProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const agentPreset = typeof useProjection === 'function' ? (useProjection('agentPreset') as string | undefined) : undefined
  const peer = typeof useProjection === 'function' ? useProjection('endeavourPeer') : undefined
  const plan = typeof useProjection === 'function'
    ? (useProjection('endeavourPlan') as { readonly terminal?: unknown } | null | undefined)
    : undefined
  const sessionId = (props as { readonly sessionId?: string }).sessionId
  const { roles } = props.unifiedModels
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
  // Admission is LATCHED per session: the projection can publish null or a
  // half-written snapshot while the menu's own state renders, and re-reading it
  // here would unmount an established control. Only a session that was actually
  // observed as the Endeavour side of a validated pair is ever admitted, so an
  // initially absent, invalid or Challenger-side session still renders nothing.
  const role = peerRoleOfProjection(peer, sessionId)
  const admittedSession = useRef<string | undefined>(undefined)
  if (role === 'endeavour' && sessionId !== undefined) admittedSession.current = sessionId
  const hideReason = builderControlDisabled({ ...visibility, planActive: false, running: false })
  const disabledReason = hideReason !== undefined ? undefined : builderControlDisabled(visibility)
  const show = hideReason === undefined && sessionId !== undefined && admittedSession.current === sessionId

  const [selections, setSelections] = useState<Record<UnifiedRole, UnifiedSelection | undefined>>(() => ({
    endeavour: roles.endeavour.readSelection(),
    challenger: roles.challenger.readSelection(),
  }))
  const [catalogs, setCatalogs] = useState<Record<UnifiedRole, CatalogState>>(emptyCatalog)
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>({ kind: 'root' })
  const [busy, setBusy] = useState(false)
  // Bumped by a role retry: it re-runs the availability read and the rows memo.
  const [retryToken, setRetryToken] = useState(0)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
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

  /** Per-render availability: a transient outage is reported in the menu. */
  const roleAvailable = (target: UnifiedRole): boolean => roles[target].available()
  // Re-subscribe when either role's availability changes, so a recovered role
  // starts mirroring again and a recovered directory gets its catalog.
  const availabilityKey = UNIFIED_ROLES.map((target) => (roleAvailable(target) ? '1' : '0')).join('')

  // Both peers are mirrored live: each role owns its own selection.
  useEffect(() => {
    const refresh = (): void => {
      setSelections({ endeavour: roles.endeavour.readSelection(), challenger: roles.challenger.readSelection() })
    }
    refresh()
    const offEndeavour = roles.endeavour.subscribeSelection(refresh)
    const offChallenger = roles.challenger.subscribeSelection(refresh)
    for (const target of UNIFIED_ROLES) {
      if (roleAvailable(target)) setCatalogs((current) => (current[target].kind === 'error' ? { ...current, [target]: { kind: 'idle' } } : current))
    }
    return () => {
      offEndeavour()
      offChallenger()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles, availabilityKey])

  /** Retry re-resolves ONE role's directory and reloads its catalog. */
  const retryRole = (target: UnifiedRole): void => {
    setRetryToken((value) => value + 1)
    if (!roles[target].available()) return
    loadCatalog(target)
  }

  useEffect(() => {
    if (!open) return
    // Both catalogs load when the menu opens, each from its own directory and
    // exactly once per open (a resolved role is skipped by `loadCatalog`'s
    // caller-side guard below).
    for (const target of UNIFIED_ROLES) {
      if (catalogs[target].kind !== 'idle') continue
      loadCatalog(target)
    }
  }, [open, catalogs, loadCatalog])

  useEffect(() => {
    if (!open) return undefined
    setPane({ kind: 'root' })
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!(rootRef.current?.contains(target) ?? false) && !(menuRef.current?.contains(target) ?? false)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  const catalogValue = (target: UnifiedRole): UnifiedCatalog | undefined => {
    const state = catalogs[target]
    return state.kind === 'ready' ? state.catalog : undefined
  }
  const modelOf = useCallback((target: UnifiedRole): ModelCatalogModel | undefined => {
    const selection = selections[target]
    return findCatalogModel(catalogValue(target), selection?.provider, selection?.model)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogs, selections])

  const modelLabelOf = (target: UnifiedRole): string | undefined => {
    const selection = selections[target]
    if (selection === undefined) return undefined
    return modelOf(target)?.name ?? selection.model
  }
  const thinkingLabelOf = (target: UnifiedRole): string | undefined => {
    const selection = selections[target]
    if (selection === undefined) return undefined
    const model = modelOf(target)
    return modelHasThinking(model)
      ? (effortLabelFor(model, selection.reasoningEffort) ?? copy('builder.default'))
      : copy('builder.notAvailable')
  }
  const canDrillThinking = (target: UnifiedRole): boolean => {
    const selection = selections[target]
    return selection !== undefined && modelHasThinking(modelOf(target))
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (!open) return []
    if (pane.kind === 'root') {
      const list: MenuRow[] = []
      for (const target of UNIFIED_ROLES) {
        const roleName = copy(target === 'endeavour' ? 'unified.endeavour' : 'unified.challenger')
        const available = roleAvailable(target)
        list.push({ id: `section:${target}`, kind: 'section', label: roleName })
        if (!available) {
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
          value: available
            ? (modelLabelOf(target) ?? (state.kind === 'error' ? copy('builder.error') : copy('builder.loading')))
            : copy('builder.notAvailable'),
          disabled: !available,
          action: () => { setPane({ kind: 'model', role: target }) },
        })
        list.push({
          id: `thinking:${target}`,
          kind: 'cell',
          label: copy('builder.effort'),
          value: available
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
      const selection = selections[target]
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
      const selection = selections[target]
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
  }, [open, pane, catalogs, selections, roles, retryToken])

  const enabledRows = rows.filter((row) => row.kind !== 'section' && row.kind !== 'group' && row.kind !== 'note' && row.disabled !== true)
  const activeRow = enabledRows[Math.min(activeIndex, Math.max(enabledRows.length - 1, 0))]

  useEffect(() => {
    if (!open) return
    const selectedIndex = enabledRows.findIndex((row) => row.selected === true)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane.kind, catalogKindKey(catalogs)])

  const place = useCallback((): void => {
    const menu = menuRef.current
    const trigger = chipRef.current
    if (menu === null || trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const above = rect.top - 8 - height
    const y = above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8)
    setMenuPos((current) => (current !== null && current.left === x && current.top === y ? current : { position: 'fixed', left: x, top: y }))
  }, [])

  useLayoutEffect(() => {
    if (!open) return undefined
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, pane, catalogs, place])

  /** Write through the target role's directory, preserving the other role. */
  const select = (target: UnifiedRole, provider: string, model: string, effort: string | undefined): void => {
    setBusy(true)
    setSaveError(undefined)
    void roles[target].select(provider, model, effort).then(
      () => { setBusy(false) },
      (error: unknown) => {
        setBusy(false)
        setSaveError(String((error as Error).message ?? error))
        // Re-read the rejected role so its displayed selection never keeps a
        // value the directory refused; the other role is untouched.
        setSelections((current) => ({ ...current, [target]: roles[target].readSelection() }))
      },
    )
  }

  function chooseModel(target: UnifiedRole, provider: string, modelId: string): void {
    const model = findCatalogModel(catalogValue(target), provider, modelId)
    // Only THIS role's effort resets, to the model's own catalog default.
    select(target, provider, modelId, model?.reasoning?.defaultEffort)
    setOpen(false)
  }
  function chooseEffort(target: UnifiedRole, effort: string | undefined): void {
    const selection = selections[target]
    if (selection === undefined) return
    // The model of that role is preserved.
    select(target, selection.provider, selection.model, effort)
    setOpen(false)
  }

  if (!show) return null
  const paneRole: UnifiedRole | undefined = pane.kind === 'root' ? undefined : pane.role
  return (
    <div ref={rootRef} className={CLASS.unifiedControl} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (pane.kind !== 'root') { setPane({ kind: 'root' }); return }
        setOpen(false)
        chipRef.current?.focus()
        return
      }
      if (event.key === 'Tab') { event.preventDefault(); setOpen(false); chipRef.current?.focus(); return }
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
    }}>
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
        onClick={() => { setOpen((value) => !value); setPane({ kind: 'root' }); setMenuPos(null) }}
      >
        <SlidersMark />
      </button>
      {open ? createPortal(
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
          {saveError === undefined ? null : <div className={CLASS.menuError}>{copy('builder.saveFailed')}</div>}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

/** Stable key for the catalog state so the active-row effect re-runs on load. */
function catalogKindKey(catalogs: Record<UnifiedRole, CatalogState>): string {
  return UNIFIED_ROLES.map((role) => catalogs[role].kind).join(':')
}

/** Re-exported helper for tests: the catalog model metadata type. */
export type { ModelCatalogModel }
