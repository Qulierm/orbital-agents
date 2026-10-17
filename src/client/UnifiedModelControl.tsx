/* Compact Challenger selector: browser-local draft before peer readiness. */

import { Component, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
import { validatePeerState, type PeerState } from '../peer.js'
import { peerView } from '../peer-projection.js'
import { copyFrom } from './PlanCard.js'
import { effortLabelFor, findCatalogModel, modelHasThinking, thinkingOptions } from './builder-route-model.js'
import { CLASS } from './styles.js'
import type { EndeavourKey } from './locales.js'
import type { PendingChallengerSelection, PendingChallengerSelectionSnapshot } from './challenger-selection-store.js'

/** The two ordinary sessions this control may observe. */
export type UnifiedRole = 'endeavour' | 'challenger'
/** Menu order, retained for consumers and tests. */
export const UNIFIED_ROLES: readonly UnifiedRole[] = ['endeavour', 'challenger']

/** One ordinary-session model selection. */
export interface UnifiedSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One owned peer session reference. */
export interface UnifiedRoleLease {
  readonly ready: Promise<unknown>
  readonly release: () => void
}

/** One role's official ModelDirectory bridge. */
export interface UnifiedRoleController {
  readonly available: () => boolean
  readonly readSelection: () => UnifiedSelection | undefined
  readonly subscribeSelection: (listener: () => void) => () => void
  readonly loadCatalog: () => Promise<unknown>
  readonly select: (provider: string, model: string, reasoningEffort: string | undefined) => Promise<void>
  readonly acquire?: (expectedSessionId?: string) => UnifiedRoleLease | undefined
}

/** Stable current data source and validated write target for this root. */
export interface UnifiedModelSourceSnapshot {
  readonly mode: 'hidden' | 'draft' | 'peer'
  readonly key: string
  readonly generation: number
  readonly peerId?: string
}

/** Browser-local outstanding choice methods owned by the root bridge. */
export interface UnifiedPendingSelectionController {
  readonly getSnapshot: () => PendingChallengerSelectionSnapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly save: (selection: UnifiedSelection) => Promise<PendingChallengerSelection>
  readonly removeIfRevision: (revision: string) => Promise<boolean>
}

/** Per-root controller assembled by the client bridge. */
export interface UnifiedModelController {
  readonly roles: Readonly<Record<UnifiedRole, UnifiedRoleController>>
  readonly sourceSnapshot: () => UnifiedModelSourceSnapshot
  readonly subscribeSource: (listener: () => void) => () => void
  readonly pendingSelection: UnifiedPendingSelectionController
  readonly applyPendingToPeer: (revision: string, peerId: string, generation: number) => Promise<boolean>
  readonly admit?: (preset: string | undefined) => boolean
}

/** Catalog groups consumed by the native ModelSelect directory. */
export interface UnifiedCatalog {
  readonly groups: readonly { readonly id: string; readonly models: readonly ModelCatalogModel[] }[]
}

/** Slot props for the right-list selector. */
export type UnifiedModelControlProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'endeavour'> & { readonly unifiedModels: UnifiedModelController }

type CatalogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: UnifiedCatalog }
  | { readonly kind: 'error'; readonly message: string }

/** Peer or inherited root selection captured after commit. */
interface PeerView {
  readonly available: boolean
  readonly pending: boolean
  readonly probed: boolean
  readonly selection?: UnifiedSelection
}
const pendingPeer: PeerView = { available: false, pending: true, probed: false }
function settled(available: boolean, selection?: UnifiedSelection): PeerView {
  return selection === undefined ? { available, pending: false, probed: true } : { available, pending: false, probed: true, selection }
}

/** Compare selection fields without depending on object identity. */
export function sameSelection(left: UnifiedSelection | undefined, right: UnifiedSelection | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
function samePeerView(left: PeerView, right: PeerView): boolean {
  return left.available === right.available && left.pending === right.pending && left.probed === right.probed && sameSelection(left.selection, right.selection)
}

const MENU_WIDTH = 320
const MENU_MIN_HEIGHT = 96
export const MENU_DETAIL_MAX = 160
export const CHALLENGER_TRIGGER_ATTR = 'data-endeavour-challenger-models'
export const CHALLENGER_PANE_ATTR = 'data-endeavour-challenger-pane'
const MEASURE_STYLE: React.CSSProperties = { position: 'fixed', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none' }

type MenuOperation = 'readSelection' | 'available' | 'subscribeSelection' | 'acquire'
function roleOperation<T>(role: UnifiedRole, operation: MenuOperation, run: () => T): T {
  try { return run() } catch (error) {
    throw new Error(`${role}.${operation}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Make a bounded error string safe for the menu fallback. */
export function safeDiagnostic(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const raw = `${error.name}: ${error.message}`.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (raw === '') return undefined
  return raw.length > MENU_DETAIL_MAX ? `${raw.slice(0, MENU_DETAIL_MAX - 1)}…` : raw
}

/** Peer side of this session for the legacy fallback. */
function peerRoleOfProjection(peer: unknown, sessionId: string | undefined): 'endeavour' | 'challenger' | undefined {
  if (sessionId === undefined || peer === null || peer === undefined) return undefined
  const state = peer as PeerState
  if (validatePeerState(state).length > 0) return undefined
  return peerView(state, sessionId)?.role
}

const emptyPendingSnapshot: PendingChallengerSelectionSnapshot = Object.freeze({})
const emptyPendingController: UnifiedPendingSelectionController = {
  getSnapshot: () => emptyPendingSnapshot,
  subscribe: () => () => undefined,
  save: async () => { throw new Error('pending Challenger selection store is unavailable') },
  removeIfRevision: async () => false,
}

/** Compact custom dropdown. Its visible label never includes model details. */
export function ChallengerModelControl(props: UnifiedModelControlProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const agentPreset = typeof useProjection === 'function' ? useProjection('agentPreset') as string | undefined : undefined
  const peerProjection = typeof useProjection === 'function' ? useProjection('endeavourPeer') : undefined
  const sessionId = (props as { readonly sessionId?: string }).sessionId
  const role = peerRoleOfProjection(peerProjection, sessionId)
  const admitted = props.unifiedModels.admit === undefined
    ? undefined
    : sessionId === undefined ? false : props.unifiedModels.admit(agentPreset)
  const show = admitted === undefined ? role === 'endeavour' : admitted

  const fallbackSource = useMemo<UnifiedModelSourceSnapshot>(() => ({
    mode: show ? 'peer' : 'hidden',
    key: show ? `legacy-peer:${sessionId ?? ''}` : `hidden:${sessionId ?? ''}`,
    generation: 0,
  }), [sessionId, show])
  const fallbackGetSourceSnapshot = useCallback(() => fallbackSource, [fallbackSource])
  const emptySourceSubscription = useCallback(() => () => undefined, [])
  const sourceSnapshot = props.unifiedModels.sourceSnapshot ?? fallbackGetSourceSnapshot
  const subscribeSource = props.unifiedModels.subscribeSource ?? emptySourceSubscription
  const source = useSyncExternalStore(subscribeSource, sourceSnapshot, sourceSnapshot)
  const pendingController = props.unifiedModels.pendingSelection ?? emptyPendingController
  const subscribePending = useCallback((listener: () => void) => source.mode === 'hidden'
    ? () => undefined
    : pendingController.subscribe(listener), [pendingController, source.mode])
  const pendingSnapshot = useSyncExternalStore(subscribePending, pendingController.getSnapshot, pendingController.getSnapshot)
  const pendingRecord = pendingSnapshot.record
  const roles = props.unifiedModels.roles

  const [sourceView, setSourceView] = useState<PeerView>(pendingPeer)
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const [menuAttempt, setMenuAttempt] = useState(0)
  const [sourceAttempt, setSourceAttempt] = useState(0)
  const [applyAttempt, setApplyAttempt] = useState(0)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [applyError, setApplyError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const generationRef = useRef(0)
  const menuOwnerRef = useRef(0)
  const saveGenerationRef = useRef(0)
  const mountedRef = useRef(true)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuId = `${useId()}-challenger-menu`
  const publishView = useCallback((next: PeerView): void => {
    setSourceView((old) => samePeerView(old, next) ? old : next)
  }, [])
  const invalidateMenuOwner = useCallback((): void => {
    menuOwnerRef.current += 1
    saveGenerationRef.current += 1
  }, [])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      invalidateMenuOwner()
    }
  }, [invalidateMenuOwner])

  /** Bind to one root read source or the exact validated peer after commit. */
  useEffect(() => {
    const generation = ++generationRef.current
    let closed = false
    let lease: UnifiedRoleLease | undefined
    let dispose: (() => void) | undefined
    const stale = (): boolean => {
      const current = sourceSnapshot()
      return closed || generationRef.current !== generation || current.key !== source.key || current.generation !== source.generation
    }
    const cleanup = (): void => {
      if (closed) return
      closed = true
      generationRef.current += 1
      try { dispose?.() } catch { /* A disposer failure must not skip reference release. */ }
      dispose = undefined
      try { lease?.release() } catch { /* Release is best-effort. */ }
      lease = undefined
    }
    if (!show || source.mode === 'hidden') {
      publishView(pendingPeer)
      setCatalog({ kind: 'idle' })
      return cleanup
    }
    publishView(pendingPeer)
    setCatalog({ kind: 'idle' })
    const draft = source.mode === 'draft'
    const readRole: UnifiedRole = draft ? 'endeavour' : 'challenger'
    const load = (): void => {
      void roles.challenger.loadCatalog().then(
        (value) => { if (!stale()) setCatalog({ kind: 'ready', catalog: value as UnifiedCatalog }) },
        (error: unknown) => { if (!stale()) setCatalog({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) },
      )
    }
    const attach = (): void => {
      if (stale()) return
      if (!roleOperation(readRole, 'available', () => roles[readRole].available())) {
        publishView(settled(false))
        setCatalog({ kind: 'error', message: 'The model directory is unavailable.' })
        return
      }
      publishView(settled(true, roleOperation(readRole, 'readSelection', () => roles[readRole].readSelection())))
      setCatalog({ kind: 'loading' })
      dispose = roleOperation(readRole, 'subscribeSelection', () => roles[readRole].subscribeSelection(() => {
        if (stale()) return
        try {
          const available = roleOperation(readRole, 'available', () => roles[readRole].available())
          publishView(available ? settled(true, roleOperation(readRole, 'readSelection', () => roles[readRole].readSelection())) : settled(false))
        } catch { publishView(settled(false)) }
      }))
      load()
    }
    if (!draft && source.peerId !== undefined) {
      try { lease = roleOperation('challenger', 'acquire', () => roles.challenger.acquire?.(source.peerId)) }
      catch {
        publishView(settled(false))
        setCatalog({ kind: 'error', message: 'The Challenger session is unavailable.' })
        return cleanup
      }
    }
    if (lease === undefined) {
      try { attach() } catch {
        cleanup()
        publishView(settled(false))
        setCatalog({ kind: 'error', message: 'The model directory is unavailable.' })
      }
      return cleanup
    }
    void lease.ready.then(
      () => {
        if (stale()) return
        try { attach() } catch {
          cleanup()
          publishView(settled(false))
          setCatalog({ kind: 'error', message: 'The Challenger session is unavailable.' })
        }
      },
      () => {
        try { lease?.release() } catch { /* Failed reference is dropped below. */ }
        lease = undefined
        if (!stale()) {
          publishView(settled(false))
          setCatalog({ kind: 'error', message: 'The Challenger session is unavailable.' })
        }
      },
    )
    return cleanup
  }, [publishView, roles, show, sourceAttempt, source.generation, source.key, source.mode, source.peerId, sourceSnapshot])

  /** A newly saved revision or actual readiness transition gets one apply attempt. */
  useEffect(() => {
    if (source.mode !== 'peer' || source.peerId === undefined || !sourceView.available || pendingRecord === undefined) return
    let active = true
    setBusy(true)
    setApplyError(undefined)
    void props.unifiedModels.applyPendingToPeer(pendingRecord.revision, source.peerId, source.generation).then(
      () => { if (active) { setBusy(false); setApplyError(undefined) } },
      (error: unknown) => { if (active) { setBusy(false); setApplyError(error instanceof Error ? error.message : String(error)) } },
    )
    return () => { active = false }
  }, [pendingRecord?.revision, props.unifiedModels, source.generation, source.mode, source.peerId, sourceView.available, applyAttempt])

  const retry = (): void => {
    setCatalog({ kind: 'idle' })
    setApplyError(undefined)
    setSourceAttempt((value) => value + 1)
    setApplyAttempt((value) => value + 1)
  }
  const save = async (provider: string, model: string, effort: string | undefined): Promise<boolean> => {
    const owner = menuOwnerRef.current
    const attempt = ++saveGenerationRef.current
    setSaveError(undefined)
    setApplyError(undefined)
    try {
      await pendingController.save({ provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      return mountedRef.current && owner === menuOwnerRef.current && attempt === saveGenerationRef.current
    } catch (error) {
      if (mountedRef.current && owner === menuOwnerRef.current && attempt === saveGenerationRef.current) {
        setSaveError(error instanceof Error ? error.message : 'Could not save the Challenger choice in this browser.')
      }
      return false
    }
  }

  if (!show || source.mode === 'hidden') return null
  const effectiveSelection: UnifiedSelection | undefined = pendingRecord === undefined
    ? sourceView.selection
    : { provider: pendingRecord.provider, model: pendingRecord.model, ...(pendingRecord.reasoningEffort === undefined ? {} : { reasoningEffort: pendingRecord.reasoningEffort }) }
  const model = catalog.kind === 'ready' ? findCatalogModel(catalog.catalog, effectiveSelection?.provider, effectiveSelection?.model) : undefined
  const modelName = effectiveSelection === undefined ? undefined : model?.name ?? effectiveSelection.model
  const effort = effectiveSelection !== undefined && model !== undefined && modelHasThinking(model)
    ? effortLabelFor(model, effectiveSelection.reasoningEffort) ?? copy('builder.default') : undefined
  const selected = modelName === undefined ? (sourceView.pending || !sourceView.probed ? copy('builder.loading') : copy('builder.notAvailable')) : effort === undefined ? modelName : `${modelName} ${effort}`
  const status = pendingSnapshot.error !== undefined || saveError !== undefined
    ? copy('challenger.storageError')
    : pendingRecord !== undefined ? (applyError === undefined ? copy('challenger.pending') : copy('challenger.pendingError'))
      : source.mode === 'draft' ? copy('challenger.waitingForPeer') : undefined
  const description = copy('challenger.triggerWith', { selection: [selected, status].filter((part): part is string => part !== undefined).join('. ') })

  return (
    <div ref={shellRef} className={CLASS.challengerControl}>
      <button
        ref={triggerRef}
        type="button"
        {...{ [CHALLENGER_TRIGGER_ATTR]: '' }}
        className={CLASS.challengerTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        aria-label={description}
        aria-busy={busy}
        aria-disabled={false}
        title={description}
        onClick={() => { invalidateMenuOwner(); setOpen((value) => !value) }}
      >
        <span className={CLASS.challengerTriggerLabel} data-endeavour-challenger-label="">{copy('unified.challenger')}</span>
        <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={open ? CLASS.challengerChevronOpen : CLASS.challengerChevron}>
          <path d="M4 6.5 8 10.5l4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? createPortal(
        <MenuBoundary key={menuAttempt} copy={copy} triggerRef={triggerRef} onRetry={() => { invalidateMenuOwner(); setMenuAttempt((value) => value + 1) }}>
          <ChallengerMenu
            id={menuId}
            copy={copy}
            peer={{ ...sourceView, ...(effectiveSelection === undefined ? {} : { selection: effectiveSelection }) }}
            catalog={catalog}
            pending={pendingRecord !== undefined}
            sourceMode={source.mode}
            storageError={pendingSnapshot.error ?? saveError}
            applyError={applyError}
            saveError={saveError}
            onRetry={retry}
            onSelect={save}
            triggerRef={triggerRef}
            shellRef={shellRef}
            onClose={(restoreFocus) => { invalidateMenuOwner(); setOpen(false); if (restoreFocus) triggerRef.current?.focus() }}
          />
        </MenuBoundary>, document.body,
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

/** Keep popup failures local to the menu and leave the trigger available. */
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
    return <div role="menu" aria-label={this.props.copy('unified.error')} className={CLASS.menu} data-endeavour-menu-error="" data-menu-material="translucent" style={style}>
      <span className={CLASS.menuMaterial} aria-hidden="true" />
      <div className={CLASS.menuNote}>
        <span>{this.props.copy('unified.error')}</span>
        {this.state.detail === undefined ? null : <span data-endeavour-menu-error-detail="">{this.props.copy('unified.errorDetail', { detail: this.state.detail })}</span>}
        <button type="button" className={CLASS.menuRetry} data-endeavour-menu-retry="" onClick={() => { this.setState({ failed: false }); this.props.onRetry() }}>{this.props.copy('builder.retry')}</button>
      </div>
    </div>
  }
}

interface MenuRow {
  readonly id: string
  readonly kind: 'cell' | 'option' | 'group' | 'note' | 'retry'
  readonly label: string
  readonly value?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly action?: () => void
}

interface ChallengerMenuProps {
  readonly id: string
  readonly copy: (key: EndeavourKey, params?: Record<string, string | number>) => string
  readonly peer: PeerView
  readonly catalog: CatalogState
  readonly pending: boolean
  readonly sourceMode: 'draft' | 'peer'
  readonly storageError: string | undefined
  readonly applyError: string | undefined
  readonly saveError: string | undefined
  readonly onRetry: () => void
  readonly onSelect: (provider: string, model: string, effort: string | undefined) => Promise<boolean>
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>
  readonly shellRef: React.RefObject<HTMLDivElement | null>
  readonly onClose: (restoreFocus: boolean) => void
}

/** Peer menu rendered from post-commit snapshots; it never probes a directory. */
function ChallengerMenu(props: ChallengerMenuProps): React.ReactElement {
  const { copy } = props
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const peer = props.peer
  const catalog = props.catalog
  const selection = peer.selection
  const settledProbe = peer.probed && !peer.pending
  const available = settledProbe && peer.available
  const loading = !settledProbe
  const catalogValue = catalog.kind === 'ready' ? catalog.catalog : undefined
  const model = findCatalogModel(catalogValue, selection?.provider, selection?.model)
  const modelLabel = !loading && available
    ? selection === undefined ? copy('builder.unset') : model?.name ?? selection.model
    : loading ? copy('builder.loading') : copy('builder.notAvailable')
  const effortLabel = !loading && available
    ? selection === undefined ? copy('builder.unset') : model !== undefined && modelHasThinking(model) ? effortLabelFor(model, selection.reasoningEffort) ?? copy('builder.default') : copy('builder.notAvailable')
    : loading ? copy('builder.loading') : copy('builder.notAvailable')
  const canDrill = selection !== undefined && model !== undefined && modelHasThinking(model)

  function openPane(next: 'root' | 'model' | 'effort'): void {
    setActiveIndex(null)
    setHoverIndex(null)
    setPane(next)
  }
  async function chooseSelection(provider: string, model: string, effort: string | undefined): Promise<void> {
    try {
      if (await props.onSelect(provider, model, effort)) props.onClose(false)
    } catch {
      // The owning control reports save failures and keeps this menu open.
    }
  }
  function chooseModel(provider: string, entry: ModelCatalogModel): void {
    void chooseSelection(provider, entry.id, entry.reasoning?.defaultEffort)
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (!settledProbe) return [
      { id: 'model', kind: 'cell', label: copy('builder.model'), value: copy('builder.loading'), disabled: true },
      { id: 'effort', kind: 'cell', label: copy('builder.effort'), value: copy('builder.loading'), disabled: true },
    ]
    if (!peer.available) return [{ id: 'unavailable', kind: 'retry', label: copy('unified.unavailable', { role: copy('unified.challenger') }), action: props.onRetry }]
    if (pane === 'root') return [
      { id: 'model', kind: 'cell', label: copy('builder.model'), value: modelLabel, action: () => { openPane('model') } },
      { id: 'effort', kind: 'cell', label: copy('builder.effort'), value: effortLabel, disabled: !canDrill, action: () => { if (canDrill) openPane('effort') } },
    ]
    if (pane === 'model') {
      if (catalogValue === undefined) return [{ id: 'error', kind: 'note', label: catalog.kind === 'error' ? copy('builder.error') : copy('builder.loading'), action: props.onRetry }]
      return catalogValue.groups.flatMap((group) => [
        { id: `group:${group.id}`, kind: 'group' as const, label: group.id },
        ...group.models.map((entry) => ({
          id: `model:${group.id}:${entry.id}`,
          kind: 'option' as const,
          label: entry.name,
          selected: selection?.provider === group.id && selection.model === entry.id,
          action: () => { chooseModel(group.id, entry) },
        })),
      ])
    }
    if (catalogValue === undefined || model === undefined || selection === undefined) return [{ id: 'error', kind: 'note', label: copy('builder.error'), action: props.onRetry }]
    return (model.reasoning?.efforts ?? []).map((effort) => ({
      id: `effort:${effort.id}`,
      kind: 'option' as const,
      label: effort.name,
      selected: (selection.reasoningEffort ?? model.reasoning?.defaultEffort) === effort.id,
      action: () => { void chooseSelection(selection.provider, selection.model, effort.id) },
    }))
  }, [catalog.kind, catalogValue, canDrill, copy, effortLabel, modelLabel, pane, peer.available, props, selection, settledProbe])

  const enabledRows = rows.filter((row) => row.disabled !== true && (row.kind === 'cell' || row.kind === 'option' || row.kind === 'retry'))
  const keyboardRow = activeIndex === null ? undefined : enabledRows[activeIndex]
  const hoverRow = hoverIndex === null ? undefined : enabledRows[hoverIndex]
  const activeRow = hoverRow ?? keyboardRow
  const activeRowIndex = activeRow === undefined ? -1 : enabledRows.indexOf(activeRow)

  const place = useCallback((): void => {
    const menu = menuRef.current
    const trigger = props.triggerRef.current
    if (menu === null || trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const x = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const above = rect.top - height - 8
    const y = Math.max(8, above >= 8 ? above : Math.min(rect.bottom + 8, window.innerHeight - height - 8))
    setMenuPos((current) => current !== null && current.left === x && current.top === y ? current : { position: 'fixed', left: x, top: y })
  }, [props.triggerRef])
  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [pane, catalog.kind, place])
  useEffect(() => { setActiveIndex(null); setHoverIndex(null) }, [pane, catalog.kind])
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!(props.shellRef.current?.contains(target) ?? false) && !(menuRef.current?.contains(target) ?? false)) props.onClose(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [props.onClose, props.shellRef])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (pane === 'root') props.onClose(true)
        else openPane('root')
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHoverIndex(null)
        if (enabledRows.length === 0) return
        setActiveIndex((index) => index === null
          ? event.key === 'ArrowDown' ? 0 : enabledRows.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabledRows.length) % enabledRows.length)
        return
      }
      if ((event.key === 'Enter' || event.key === ' ') && activeIndex !== null && activeRow?.action !== undefined) {
        event.preventDefault()
        activeRow.action()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [activeIndex, activeRow, enabledRows, pane, props.onClose])

  const status = props.storageError !== undefined ? copy('challenger.storageError')
    : props.applyError !== undefined ? copy('challenger.pendingError')
      : props.pending ? copy('challenger.pending')
        : props.sourceMode === 'draft' ? copy('challenger.waitingForPeer') : undefined

  return <div
    ref={menuRef}
    id={props.id}
    role="menu"
    aria-label={copy('challenger.menu')}
    {...{ [CHALLENGER_PANE_ATTR]: pane }}
    data-menu-material="translucent"
    className={CLASS.menu}
    style={menuPos ?? MEASURE_STYLE}
  >
    <span className={CLASS.menuMaterial} aria-hidden="true" />
    <div className={CLASS.menuRows} onPointerLeave={() => { setHoverIndex(null) }}>
      {status === undefined ? null : <div className={CLASS.menuNote} data-endeavour-selection-status="">{status}</div>}
      {props.storageError !== undefined || props.saveError !== undefined || props.applyError !== undefined
        ? <div className={CLASS.menuNote} role="status" data-endeavour-selection-error="">
            <span>{copy('challenger.selectionError')}</span>
            <button type="button" className={CLASS.menuRetry} onClick={props.onRetry}>{copy('builder.retry')}</button>
          </div>
        : null}
      {rows.map((row) => {
        if (row.kind === 'group') return <div key={row.id} className={CLASS.menuGroup}>{row.label}</div>
        if (row.kind === 'note') return <div key={row.id} className={CLASS.menuNote}>
          <span>{row.label}</span>{row.action === undefined ? null : <button type="button" className={CLASS.menuRetry} onClick={row.action}>{copy('builder.retry')}</button>}
        </div>
        const active = enabledRows.indexOf(row) === activeRowIndex && activeRowIndex >= 0
        const pointerProps = {
          onPointerEnter: () => { setHoverIndex(enabledRows.indexOf(row)) },
          onPointerLeave: () => { setHoverIndex((current) => current === enabledRows.indexOf(row) ? null : current) },
        }
        if (row.kind === 'retry') return <button key={row.id} type="button" role="menuitem" data-endeavour-retry="challenger" {...pointerProps} onClick={() => { row.action?.() }} className={active ? CLASS.menuOptionActive : CLASS.menuOption}>
          <span className={CLASS.menuOptionCopy}><span className={CLASS.menuOptionName}>{row.label}</span></span><span className={CLASS.menuCheck}>{copy('builder.retry')}</span>
        </button>
        if (row.kind === 'cell') return <button key={row.id} type="button" role="menuitem" disabled={row.disabled === true} aria-haspopup="menu" {...pointerProps} onClick={() => { row.action?.() }} className={active ? CLASS.menuCellActive : CLASS.menuCell}>
          <span className={CLASS.menuCellLabel}>{row.label}</span><span className={CLASS.menuCellValue}>{row.value}</span>
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={CLASS.menuCellChevron}><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        return <button key={row.id} type="button" role="menuitemradio" aria-checked={row.selected === true} {...pointerProps} onClick={() => { row.action?.() }} className={active ? CLASS.menuOptionActive : CLASS.menuOption}>
          <span className={CLASS.menuOptionCopy}><span className={CLASS.menuOptionName}>{row.label}</span></span>{row.selected === true ? <span className={CLASS.menuCheck} aria-hidden="true">✓</span> : null}
        </button>
      })}
      {props.saveError === undefined ? null : <div className={CLASS.menuError}>{copy('builder.saveFailed')}</div>}
    </div>
  </div>
}

/** Catalog model metadata type used by tests and fixtures. */
export type { ModelCatalogModel }
