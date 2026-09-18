/**
 * Builder route control for the root Endeavour composer.
 *
 * Renders a compact chip (integrated with the composer toolbar) whose menu
 * selects the route for the NEXT Builder child. The menu mirrors the upstream
 * ModelSelect shape: a root pane with exactly two drill rows ("Model" and
 * "Thinking"), a model pane (Back + Inherit Planner + provider-grouped models),
 * and a thinking pane (Back + the adapter-owned efforts of the selected model).
 * It is visible only in an Endeavour root session, disabled while a plan is
 * active or the turn runs, and never touches an already-spawned Builder.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog, ModelCatalogModel } from '@deepseek-ai/dsh-api-session-controller/types'
import type { BuilderRouteSettings } from '../builder-settings.js'

import { copyFrom } from './PlanCard.js'
import {
  builderControlDisabled,
  builderControlVisible,
  findCatalogModel,
  modelHasThinking,
  resetEffortForModel,
  thinkingOptions,
  type BuilderRouteVisibility,
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

/** Menu panes: root drills into Model or Thinking; Back returns to root. */
type Pane = 'root' | 'model' | 'thinking'

/** One menu row (header rows are labels and never focusable). */
interface MenuRow {
  readonly id: string
  readonly kind: 'drill' | 'radio' | 'back' | 'header' | 'note'
  readonly label: string
  readonly description?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly value?: string
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
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)

  const loadCatalog = (): void => {
    setCatalog({ kind: 'loading' })
    void props.builderRoute.loadCatalog().then(
      (result) => { setCatalog({ kind: 'ready', catalog: result }) },
      (error: unknown) => { setCatalog({ kind: 'error', message: String((error as Error).message ?? error) }) },
    )
  }

  // Refresh from the live settings source whenever the control opens; the chip
  // always starts on the root pane.
  useEffect(() => {
    if (!open) return undefined
    setSettings(props.builderRoute.readSettings())
    setPane('root')
    if (catalog.kind === 'idle') loadCatalog()
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const catalogValue = catalog.kind === 'ready' ? catalog.catalog : undefined
  const selectedModel = useMemo(
    () => findCatalogModel(catalogValue, settings.provider, settings.model),
    [catalogValue, settings.provider, settings.model],
  )
  const selectedHasThinking = settings.mode === 'custom' && modelHasThinking(selectedModel)
  const modelValue = settings.mode === 'custom'
    ? (selectedModel?.name ?? settings.model ?? copy('builder.inherit'))
    : copy('builder.inherit')
  const thinkingValue = settings.mode !== 'custom'
    ? copy('builder.inherited')
    : catalog.kind === 'ready' && !modelHasThinking(selectedModel)
      ? copy('builder.notAvailable')
      : settings.reasoningEffort === undefined
        ? copy('builder.providerDefault')
        : effortLabel(selectedModel, settings.reasoningEffort)

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

  const chooseInherit = (): void => { save({ mode: 'inherit' }); setPane('root') }
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
    // Stay open on the root pane so Thinking is immediately discoverable.
    setPane('root')
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (settings.mode !== 'custom') return
    save({
      mode: 'custom',
      ...(settings.provider === undefined ? {} : { provider: settings.provider }),
      ...(settings.model === undefined ? {} : { model: settings.model }),
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    })
    setPane('root')
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (!open) return []
    if (pane === 'root') {
      return [
        {
          id: 'drill:model', kind: 'drill', label: copy('builder.models'), value: modelValue,
          selected: false, action: () => { setPane('model') },
        },
        {
          id: 'drill:thinking', kind: 'drill', label: copy('builder.thinking'), value: thinkingValue,
          selected: false,
          disabled: !selectedHasThinking,
          action: () => { if (selectedHasThinking) setPane('thinking') },
        },
      ]
    }
    const back: MenuRow = {
      id: 'back', kind: 'back', label: copy('builder.back'), selected: false, action: () => { setPane('root') },
    }
    if (pane === 'thinking') {
      if (!selectedHasThinking) return [back]
      return [
        back,
        ...thinkingOptions(selectedModel, settings.reasoningEffort).map<MenuRow>((option) => ({
          id: `effort:${option.effort ?? 'default'}`,
          kind: 'radio',
          label: option.effort === undefined ? copy('builder.providerDefault') : option.label,
          ...(option.description === undefined ? {} : { description: option.description }),
          selected: option.selected,
          action: () => { chooseEffort(option.effort) },
        })),
      ]
    }
    const list: MenuRow[] = [
      back,
      {
        id: 'inherit', kind: 'radio', label: copy('builder.inherit'), description: copy('builder.inheritHint'),
        selected: settings.mode !== 'custom', action: chooseInherit,
      },
    ]
    if (catalog.kind === 'loading') list.push({ id: 'loading', kind: 'note', label: copy('builder.loading') })
    if (catalog.kind === 'error') {
      list.push({ id: 'error', kind: 'note', label: copy('builder.error'), description: catalog.message })
    }
    if (catalogValue !== undefined) {
      for (const group of catalogValue.groups) {
        list.push({ id: `group:${group.id}`, kind: 'header', label: group.name })
        for (const model of group.models) {
          list.push({
            id: `model:${group.id}:${model.id}`,
            kind: 'radio',
            label: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            selected: settings.mode === 'custom' && settings.provider === group.id && settings.model === model.id,
            action: () => { chooseModel(group.id, model.id) },
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog, catalogValue, settings, selectedModel, selectedHasThinking])

  const enabledRows = rows.filter((row) => row.kind !== 'header' && row.kind !== 'note' && row.disabled !== true)
  const activeRow = enabledRows[Math.min(activeIndex, Math.max(enabledRows.length - 1, 0))]

  // Focus lands on the selected row of the pane that is opening.
  useEffect(() => {
    if (!open) return
    const selectedIndex = enabledRows.findIndex((row) => row.selected === true)
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, catalog.kind])

  const close = (): void => {
    setOpen(false)
    setPane('root')
    chipRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (pane !== 'root') { setPane('root'); return }
      close()
      return
    }
    if (event.key === 'Tab') {
      // Menu semantics: Tab leaves the menu and hands focus back to the chip.
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
  const routeValue = settings.mode === 'custom'
    ? `${selectedModel?.name ?? settings.model ?? ''}${settings.reasoningEffort === undefined ? '' : ` · ${settings.reasoningEffort}`}`
    : copy('builder.chipInherit')
  const fullTitle = `${copy('role.builder')}: ${routeValue}`
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
        aria-label={fullTitle}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? fullTitle}
        onClick={() => { setOpen((value) => !value); setPane('root') }}
      >
        <span className={CLASS.builderValue}>{routeValue}</span>
        {saving ? <span className={CLASS.builderSaving}>{copy('builder.saving')}</span> : null}
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div role="menu" aria-label={copy('builder.title')} data-endeavour-builder-pane={pane} className={CLASS.menu}>
          {rows.map((row) => {
            if (row.kind === 'header') {
              return <div key={row.id} className={CLASS.menuHeader}>{row.label}</div>
            }
            if (row.kind === 'note') {
              return (
                <div key={row.id} className={CLASS.menuNote} title={row.description}>
                  <span>{row.label}</span>
                  {row.id === 'error' ? (
                    <button type="button" className={CLASS.ghost} onClick={loadCatalog}>{copy('builder.retry')}</button>
                  ) : null}
                </div>
              )
            }
            const active = row === activeRow
            return (
              <button
                key={row.id}
                type="button"
                role={row.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
                aria-checked={row.kind === 'radio' ? row.selected === true : undefined}
                aria-haspopup={row.kind === 'drill' ? 'menu' : undefined}
                disabled={row.disabled === true}
                onMouseEnter={() => { setActiveIndex(enabledRows.indexOf(row)) }}
                onClick={() => { row.action?.() }}
                className={active ? CLASS.menuRowActive : CLASS.menuRow}
              >
                <span className={CLASS.menuRowLabel}>
                  {row.kind === 'radio' && row.selected === true ? '✓ ' : ''}
                  {row.label}
                </span>
                {row.kind === 'drill' ? <span className={CLASS.menuRowValue}>{row.value}</span> : null}
                {row.kind === 'drill' ? (
                  <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
                {row.kind !== 'drill' && row.description === undefined ? null : (
                  row.kind === 'radio' && row.description !== undefined ? <span className={CLASS.menuRowDescription}>{row.description}</span> : null
                )}
              </button>
            )
          })}
          {saveError === undefined ? null : (
            <div className={CLASS.menuError}>{copy('builder.saveFailed')}</div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** Effort display label for the root Thinking row. */
function effortLabel(model: ModelCatalogModel | undefined, effort: string): string {
  const match = thinkingOptions(model, effort).find((option) => option.effort === effort)
  return match?.label ?? effort
}
