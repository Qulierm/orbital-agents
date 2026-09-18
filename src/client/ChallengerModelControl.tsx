/**
 * Challenger model control for the root Endeavour composer toolbar.
 *
 * The persistent Challenger owns its own ordinary-session model selection; this
 * control is only a MIRROR plus a writer. It subscribes to the paired
 * Challenger's `modelSelection` projection, shows the actual provider/model and
 * effort, and writes through the official `remote.session.selectModel` — there
 * is no inherit mode, no `Automatic`, no settings namespace and no "next child"
 * semantics. The Endeavour route is never touched.
 *
 * Presentation follows the native ModelSelect exactly: a 28px segmented trigger
 * (13/20/500 secondary label + caption effort) and a portaled card (radius 20,
 * --dsw-specific-menu, prominent elevation, 40px root cells, 14/22 typography).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
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

/** One ordinary-session model selection. */
export interface ChallengerSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Injected peer bridge: read, subscribe and write the Challenger selection. */
export interface ChallengerModelController {
  /** The paired Challenger session id for the current root, if any. */
  readonly challengerId: () => string | undefined
  readonly readSelection: () => ChallengerSelection | undefined
  readonly subscribeSelection: (listener: () => void) => () => void
  readonly loadCatalog: () => Promise<ModelCatalog>
  /** Official `remote.session.selectModel` for the Challenger session. */
  readonly select: (provider: string, model: string, reasoningEffort: string | undefined) => Promise<void>
}

/** Slot props: session seats plus the locale and the peer model bridge. */
export type ChallengerModelControlProps =
  PropsRuntime<'conversation.input.right'>
  & PropsLocale<'endeavour'>
  & { readonly challengerModel: ChallengerModelController }

type CatalogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: ModelCatalog }
  | { readonly kind: 'error'; readonly message: string }

type Pane = 'root' | 'model' | 'effort'

interface MenuRow {
  readonly id: string
  readonly kind: 'cell' | 'option' | 'group' | 'note'
  readonly label: string
  readonly value?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly action?: () => void
}

const MEASURE_STYLE: React.CSSProperties = { position: 'fixed', top: 0, left: 0, visibility: 'hidden', pointerEvents: 'none' }

/** Peer role of the current session, when it belongs to a valid pair. */
function peerRoleOfProjection(peer: unknown, sessionId: string | undefined): 'endeavour' | 'challenger' | undefined {
  if (sessionId === undefined) return undefined
  const state = (peer ?? null) as PeerState | null
  // Only an exactly valid pair grants the mirror; forged or half-written
  // checkpoints render nothing.
  if (state === null || validatePeerState(state).length > 0) return undefined
  return peerView(state, sessionId)?.role
}

export function ChallengerModelControl(props: ChallengerModelControlProps): React.ReactElement | null {
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
  // Visibility is explicit: the paired ENDEAVOUR side of a valid pair, decided
  // solely by the peer projection (role) — never by session-state child flags. A plan or a running turn
  // disables the control instead of hiding it.
  const role = peerRoleOfProjection(peer, sessionId)
  const challengerId = props.challengerModel.challengerId()
  const hideReason = builderControlDisabled({ ...visibility, planActive: false, running: false })
  const disabledReason = hideReason !== undefined
    ? undefined
    : builderControlDisabled(visibility)
  const show = hideReason === undefined && role === 'endeavour' && challengerId !== undefined

  const [selection, setSelection] = useState<ChallengerSelection | undefined>(() => props.challengerModel.readSelection())
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const loadCatalog = useCallback((): void => {
    setCatalog({ kind: 'loading' })
    void props.challengerModel.loadCatalog().then(
      (result) => { setCatalog({ kind: 'ready', catalog: result }) },
      (error: unknown) => { setCatalog({ kind: 'error', message: String((error as Error).message ?? error) }) },
    )
  }, [props.challengerModel])

  const catalogValue = catalog.kind === 'ready' ? catalog.catalog : undefined

  // The peer's selection is owned by the Challenger session: mirror it live.
  useEffect(() => {
    const refresh = (): void => { setSelection(props.challengerModel.readSelection()) }
    refresh()
    return props.challengerModel.subscribeSelection(refresh)
  }, [props.challengerModel, challengerId])

  useEffect(() => {
    if (show && catalog.kind === 'idle') loadCatalog()
  }, [show, catalog.kind, loadCatalog])

  useEffect(() => {
    if (!open) return undefined
    setPane('root')
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!(rootRef.current?.contains(target) ?? false) && !(menuRef.current?.contains(target) ?? false)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
  }, [open])

  const selectedModel = useMemo(
    () => findCatalogModel(catalogValue, selection?.provider, selection?.model),
    [catalogValue, selection?.provider, selection?.model],
  )
  const modelLabel = selection === undefined ? undefined : (selectedModel?.name ?? selection.model)
  const effortName = effortLabelFor(selectedModel, selection?.reasoningEffort)
  const effortDrillable = selection !== undefined && modelHasThinking(selectedModel)
  const effortValue = selection === undefined
    ? undefined
    : modelHasThinking(selectedModel)
      ? (effortName ?? copy('builder.default'))
      : copy('builder.notAvailable')
  const triggerLabel = modelLabel === undefined
    // A peer that never picked a route yet is honestly reported as unset
    // instead of rendering a dangling separator.
    ? copy('builder.unset')
    : selection?.reasoningEffort === undefined && !modelHasThinking(selectedModel)
      ? modelLabel
      : `${modelLabel} · ${effortName ?? copy('builder.default')}`

  const select = (provider: string, model: string, effort: string | undefined): void => {
    setBusy(true)
    setSaveError(undefined)
    void props.challengerModel.select(provider, model, effort).then(
      () => { setBusy(false) },
      (error: unknown) => {
        setBusy(false)
        setSaveError(String((error as Error).message ?? error))
        setSelection(props.challengerModel.readSelection())
      },
    )
  }

  const chooseModel = (provider: string, modelId: string): void => {
    const model = findCatalogModel(catalogValue, provider, modelId)
    const effort = model?.reasoning?.defaultEffort
    select(provider, modelId, effort)
    setOpen(false)
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (selection === undefined) return
    select(selection.provider, selection.model, effort)
    setOpen(false)
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (!open) return []
    if (pane === 'root') {
      return [
        { id: 'cell:model', kind: 'cell', label: copy('builder.model'), value: modelLabel ?? copy('builder.loading'), action: () => { setPane('model') } },
        {
          id: 'cell:effort', kind: 'cell', label: copy('builder.effort'),
          value: effortValue ?? copy('builder.loading'), disabled: !effortDrillable,
          action: () => { if (effortDrillable) setPane('effort') },
        },
      ]
    }
    if (pane === 'effort') {
      return thinkingOptions(selectedModel, selection?.reasoningEffort).map<MenuRow>((option) => ({
        id: `effort:${option.effort ?? 'default'}`,
        kind: 'option',
        label: option.effort === undefined ? copy('builder.default') : option.label,
        selected: option.selected,
        action: () => { chooseEffort(option.effort) },
      }))
    }
    const list: MenuRow[] = []
    if (catalog.kind === 'loading') list.push({ id: 'loading', kind: 'note', label: copy('builder.loading') })
    if (catalog.kind === 'error') list.push({ id: 'error', kind: 'note', label: copy('builder.error') })
    if (catalogValue !== undefined) {
      for (const group of catalogValue.groups) {
        list.push({ id: `group:${group.id}`, kind: 'group', label: group.name })
        for (const model of group.models) {
          list.push({
            id: `model:${group.id}:${model.id}`,
            kind: 'option',
            label: model.name,
            selected: selection?.provider === group.id && selection.model === model.id,
            action: () => { chooseModel(group.id, model.id) },
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog, catalogValue, selection, selectedModel, modelLabel, effortValue, effortDrillable])

  const enabledRows = rows.filter((row) => row.kind !== 'group' && row.kind !== 'note' && row.disabled !== true)
  const activeRow = enabledRows[Math.min(activeIndex, Math.max(enabledRows.length - 1, 0))]

  useEffect(() => {
    if (!open) return
    const selectedIndex = enabledRows.findIndex((row) => row.selected === true)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog.kind])

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
  }, [open, pane, catalog.kind, place])

  if (!show) return null
  return (
    <div ref={rootRef} className={CLASS.builderControl} data-endeavour-role="challenger-model" onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (pane !== 'root') { setPane('root'); return }
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
      <span className={CLASS.roleLabel} aria-hidden="true">{copy('role.builder')}</span>
      <button
        ref={chipRef}
        type="button"
        data-endeavour-challenger-model=""
        className={CLASS.builderTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${copy('role.builder')}: ${triggerLabel}`}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? triggerLabel}
        onClick={() => { setOpen((value) => !value); setPane('root'); setMenuPos(null) }}
      >
        <span className={CLASS.builderModel}>{modelLabel ?? triggerLabel}</span>
        {selection?.reasoningEffort === undefined ? null : <span className={CLASS.builderEffort}>{effortName ?? copy('builder.default')}</span>}
        {busy ? <span className={CLASS.builderSaving}>{copy('builder.saving')}</span> : null}
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" className={CLASS.builderChevron}>
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={copy('builder.title')}
          data-endeavour-challenger-pane={pane}
          className={CLASS.menu}
          style={menuPos ?? MEASURE_STYLE}
        >
          {rows.map((row) => {
            if (row.kind === 'group') return <div key={row.id} className={CLASS.menuGroup}>{row.label}</div>
            if (row.kind === 'note') {
              return (
                <div key={row.id} className={CLASS.menuNote}>
                  <span>{row.label}</span>
                  {row.id === 'error' ? <button type="button" className={CLASS.menuRetry} onClick={loadCatalog}>{copy('builder.retry')}</button> : null}
                </div>
              )
            }
            const active = row === activeRow
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

/** Re-exported helper for tests: the catalog model metadata type. */
export type { ModelCatalogModel }
