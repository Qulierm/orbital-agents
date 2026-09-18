/**
 * Builder route control for the root Endeavour composer.
 *
 * Presentation and menu follow the native ModelSelect exactly: a 28px trigger
 * (13/20/500 secondary label + caption effort) and a portaled card
 * (radius 20, --dsw-specific-menu, prominent elevation, 40px root cells, 14/22
 * typography). Inheritance is never rendered as a word: in `inherit` mode the
 * control shows the ACTUAL current Endeavour model and effort, resolved
 * reactively from the session's `modelSelection` projection with the catalog
 * default as the pre-request fallback. The Model pane's first option,
 * `Automatic`, is the way back to following Endeavour. Effort can be pinned
 * independently from the inherited model (writes a custom route with the
 * current provider/model plus the chosen effort). It is visible only in an
 * Endeavour root session, disabled while a plan is active or the turn runs,
 * and never touches an already-spawned Builder.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
import type { BuilderRouteSettings } from '../builder-settings.js'
import { copyFrom } from './PlanCard.js'
import {
  builderControlDisabled,
  builderControlVisible,
  effectiveEffortId,
  effectiveSelection,
  effortLabelFor,
  findCatalogModel,
  modelHasThinking,
  modelLabelFor,
  resetEffortForModel,
  thinkingOptions,
  type BuilderRouteVisibility,
  type ModelSelectionLike,
} from './builder-route-model.js'
import { CLASS } from './styles.js'

/** Settings bridge injected by the plugin entry. */
export interface BuilderRouteController {
  readonly readSettings: () => BuilderRouteSettings
  readonly writeSettings: (next: BuilderRouteSettings) => Promise<void>
  readonly loadCatalog: () => Promise<ModelCatalog>
}

/** Slot props: session standard seats plus the locale and settings bridge. */
export type BuilderRouteControlProps =
  PropsRuntime<'conversation.input.left'>
  & PropsLocale<'endeavour'>
  & { readonly builderRoute: BuilderRouteController }

type CatalogState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: ModelCatalog }
  | { readonly kind: 'error'; readonly message: string }

/** Native ModelSelect panes: root drills into Model or Effort. */
type Pane = 'root' | 'model' | 'effort'

/** Native Menu primitive's unplaced portal card: hidden but measurable. */
const MEASURE_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  visibility: 'hidden',
  pointerEvents: 'none',
}

interface MenuRow {
  readonly id: string
  readonly kind: 'cell' | 'option' | 'group' | 'note'
  readonly label: string
  readonly description?: string
  readonly value?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly action?: () => void
}

export function BuilderRouteControl(props: BuilderRouteControlProps): React.ReactElement | null {
  const copy = copyFrom(props)
  const useProjection = (props as { readonly useProjection?: (key: string) => unknown }).useProjection
  const useSession = (props as { readonly useSession?: (selector: (state: unknown) => unknown) => unknown }).useSession

  const agentPreset = typeof useProjection === 'function' ? (useProjection('agentPreset') as string | undefined) : undefined
  const plan = typeof useProjection === 'function'
    ? (useProjection('endeavourPlan') as { readonly terminal?: unknown } | null | undefined)
    : undefined
  const parentSelectionProjection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
  const sessionState = typeof useSession === 'function'
    ? (useSession((state: unknown) => state) as { readonly subagent?: unknown; readonly running?: boolean } | undefined)
    : undefined
  const visibility: BuilderRouteVisibility = {
    agentPreset,
    isSubagent: sessionState?.subagent !== undefined && sessionState?.subagent !== null,
    planActive: plan !== undefined && plan !== null && plan.terminal === undefined,
    running: sessionState?.running === true,
  }
  const visible = builderControlVisible(visibility)
  const disabledReason = builderControlDisabled(visibility)

  const [settings, setSettings] = useState<BuilderRouteSettings>(() => props.builderRoute.readSettings())
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('root')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(0)
  const [menuPos, setMenuPos] = useState<React.CSSProperties | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const loadCatalog = useCallback((): void => {
    setCatalog({ kind: 'loading' })
    void props.builderRoute.loadCatalog().then(
      (result) => { setCatalog({ kind: 'ready', catalog: result }) },
      (error: unknown) => { setCatalog({ kind: 'error', message: String((error as Error).message ?? error) }) },
    )
  }, [props.builderRoute])

  const catalogValue = catalog.kind === 'ready' ? catalog.catalog : undefined

  // The catalog is cheap (no model call): load as soon as the control mounts.
  useEffect(() => {
    if (visible && catalog.kind === 'idle') loadCatalog()
  }, [visible, catalog.kind, loadCatalog])

  useEffect(() => {
    if (!open) return undefined
    setSettings(props.builderRoute.readSettings())
    setPane('root')
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!(rootRef.current?.contains(target) ?? false) && !(menuRef.current?.contains(target) ?? false)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // --- effective route -----------------------------------------------------
  const inheritedSelection: ModelSelectionLike | undefined = useMemo(
    () => effectiveSelection(parentSelectionProjection, catalogValue),
    [parentSelectionProjection, catalogValue],
  )
  const customSelected = settings.mode === 'custom' && settings.provider !== undefined && settings.model !== undefined
  const activeSelection: ModelSelectionLike | undefined = customSelected
    ? {
        provider: settings.provider as string,
        model: settings.model as string,
        ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
      }
    : inheritedSelection
  const activeModel = useMemo(
    () => findCatalogModel(catalogValue, activeSelection?.provider, activeSelection?.model),
    [catalogValue, activeSelection?.provider, activeSelection?.model],
  )
  const modelLabel = modelLabelFor(activeSelection, activeModel)
  const effortId = activeSelection === undefined ? undefined : effectiveEffortId(activeModel, activeSelection.reasoningEffort)
  const effortName = effortLabelFor(activeModel, activeSelection?.reasoningEffort)
  const effortValue = activeSelection === undefined
    ? undefined
    : modelHasThinking(activeModel)
      ? (effortName ?? copy('builder.default'))
      : copy('builder.notAvailable')
  const effortDrillable = activeSelection !== undefined && modelHasThinking(activeModel)
  const triggerLabel = modelLabel === undefined
    ? ''
    : effortId === undefined
      ? modelLabel
      : `${modelLabel} · ${effortName ?? copy('builder.default')}`
  const triggerAria = modelLabel === undefined ? copy('builder.title') : `${copy('role.builder')}: ${triggerLabel}`

  const save = (next: BuilderRouteSettings): void => {
    setSettings(next)
    setSaving(true)
    setSaveError(undefined)
    void props.builderRoute.writeSettings(next).then(
      () => { setSaving(false) },
      (error: unknown) => {
        setSaving(false)
        setSaveError(String((error as Error).message ?? error))
        setSettings(props.builderRoute.readSettings())
      },
    )
  }

  const chooseAutomatic = (): void => { save({ mode: 'inherit' }); setPane('root') }
  const chooseModel = (provider: string, modelId: string): void => {
    const model = findCatalogModel(catalogValue, provider, modelId)
    const effort = resetEffortForModel(model)
    save({
      mode: 'custom',
      provider,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    })
    setPane('root')
  }
  /** Pins an effort on the CURRENT route (inherited provider/model included). */
  const chooseEffort = (effort: string | undefined): void => {
    if (activeSelection === undefined) return
    save({
      mode: 'custom',
      provider: activeSelection.provider,
      model: activeSelection.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    })
    setPane('root')
  }

  // --- pane contents -------------------------------------------------------
  const rows: readonly MenuRow[] = useMemo(() => {
    if (!open) return []
    if (pane === 'root') {
      return [
        {
          id: 'cell:model', kind: 'cell', label: copy('builder.model'),
          value: modelLabel ?? copy('builder.loading'), action: () => { setPane('model') },
        },
        {
          id: 'cell:effort', kind: 'cell', label: copy('builder.effort'),
          value: effortValue ?? copy('builder.loading'), disabled: !effortDrillable,
          action: () => { if (effortDrillable) setPane('effort') },
        },
      ]
    }
    if (pane === 'effort') {
      // Native parity: the option marked selected is the EFFECTIVE effort
      // (explicit selection, else the model's declared default).
      const options = thinkingOptions(activeModel, effortId)
      return [
        { id: 'back', kind: 'option', label: copy('builder.back'), action: () => { setPane('root') } },
        ...options.map<MenuRow>((option) => ({
          id: `effort:${option.effort ?? 'default'}`,
          kind: 'option',
          label: option.effort === undefined ? copy('builder.default') : option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
          selected: option.selected,
          action: () => { chooseEffort(option.effort) },
        })),
      ]
    }
    const list: MenuRow[] = [
      { id: 'back', kind: 'option', label: copy('builder.back'), action: () => { setPane('root') } },
      {
        id: 'automatic', kind: 'option', label: copy('builder.automatic'),
        description: copy('builder.automaticHint'), selected: !customSelected,
        action: chooseAutomatic,
      },
    ]
    if (catalog.kind === 'loading') list.push({ id: 'loading', kind: 'note', label: copy('builder.loading') })
    if (catalog.kind === 'error') list.push({ id: 'error', kind: 'note', label: copy('builder.error'), description: catalog.message })
    if (catalogValue !== undefined) {
      for (const group of catalogValue.groups) {
        list.push({ id: `group:${group.id}`, kind: 'group', label: group.name })
        for (const model of group.models) {
          list.push({
            id: `model:${group.id}:${model.id}`,
            kind: 'option',
            label: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            selected: customSelected && settings.provider === group.id && settings.model === model.id,
            action: () => { chooseModel(group.id, model.id) },
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog, catalogValue, settings, activeModel, activeSelection, effortId, customSelected, modelLabel, effortValue, effortDrillable])

  const enabledRows = rows.filter((row) => row.kind !== 'group' && row.kind !== 'note' && row.disabled !== true)
  const activeRow = enabledRows[Math.min(activeIndex, Math.max(enabledRows.length - 1, 0))]

  useEffect(() => {
    if (!open) return
    const selectedIndex = enabledRows.findIndex((row) => row.selected === true)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog.kind])

  useEffect(() => {
    if (!open) setMenuPos(null)
  }, [open])

  // Native placement: measure the rendered card, align right edges, clamp to
  // the viewport, sit above the trigger, and follow scroll/resize/content size.
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
    setMenuPos((current) => (
      current !== null && current.left === x && current.top === y ? current : { position: 'fixed', left: x, top: y }
    ))
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
  }, [open, pane, catalog.kind, settings, place])

  // The card grows when a pane/catalog arrives; keep it anchored to the trigger.
  useEffect(() => {
    if (!open || typeof ResizeObserver !== 'function') return undefined
    const menu = menuRef.current
    if (menu === null) return undefined
    const observer = new ResizeObserver(() => { place() })
    observer.observe(menu)
    return () => { observer.disconnect() }
  }, [open, pane, catalog.kind, settings, place])

  const close = useCallback((): void => {
    setOpen(false)
    setPane('root')
    setMenuPos(null)
    chipRef.current?.focus()
  }, [])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pane !== 'root') { setPane('root'); return }
      close()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (enabledRows.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (index + delta + enabledRows.length) % enabledRows.length)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const row = activeRow
      if (row?.action !== undefined) {
        event.preventDefault()
        row.action()
      }
    }
  }

  if (!visible) return null
  return (
    <div ref={rootRef} className={CLASS.builderControl} data-endeavour-role="builder" onKeyDown={onKeyDown}>
      <span className={CLASS.roleLabel} aria-hidden="true">{copy('role.builder')}</span>
      <button
        ref={chipRef}
        type="button"
        data-endeavour-builder=""
        className={CLASS.builderTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerAria}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? (modelLabel === undefined ? copy('builder.title') : triggerLabel)}
        onClick={() => { if (open) close(); else { setOpen(true); setPane('root'); setMenuPos(null) } }}
      >
        <span className={CLASS.builderModel}>{modelLabel ?? ''}</span>
        {modelLabel === undefined || effortId === undefined ? null : (
          <span className={CLASS.builderEffort}>{triggerLabel.slice(modelLabel.length + 3)}</span>
        )}
        {saving ? <span className={CLASS.builderSaving}>{copy('builder.saving')}</span> : null}
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" className={CLASS.builderChevron}>
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={copy('builder.title')}
          data-endeavour-builder-pane={pane}
          className={CLASS.menu}
          style={menuPos ?? MEASURE_STYLE}
        >
          {rows.map((row) => {
            if (row.kind === 'group') {
              return <div key={row.id} className={CLASS.menuGroup}>{row.label}</div>
            }
            if (row.kind === 'note') {
              return (
                <div key={row.id} className={CLASS.menuNote} title={row.description}>
                  <span>{row.label}</span>
                  {row.id === 'error' ? (
                    <button type="button" className={CLASS.menuRetry} onClick={loadCatalog}>{copy('builder.retry')}</button>
                  ) : null}
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
                  {row.description === undefined ? null : <span className={CLASS.menuOptionDetail}>{row.description}</span>}
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
          {saveError === undefined ? null : (
            <div className={CLASS.menuError}>{copy('builder.saveFailed')}</div>
          )}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
