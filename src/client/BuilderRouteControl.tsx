/**
 * Builder route control for the root Endeavour composer.
 *
 * Renders a compact chip (integrated with the composer toolbar) whose menu
 * selects the route for the NEXT Builder child: Inherit Planner or a custom
 * provider/model with adapter-owned thinking options. It is visible only in an
 * Endeavour root session, disabled while a plan is active or the turn runs, and
 * never touches an already-spawned Builder.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { BuilderRouteSettings } from '../builder-settings.js'
import { NS, type EndeavourKey } from './locales.js'
import { copyFrom } from './PlanCard.js'
import {
  builderChipLabel,
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

/** One flat menu row for keyboard navigation. */
interface MenuRow {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly selected: boolean
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

  // Refresh from the live settings source whenever the control opens.
  useEffect(() => {
    if (!open) return undefined
    setSettings(props.builderRoute.readSettings())
    if (catalog.kind === 'idle') loadCatalog()
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => { document.removeEventListener('mousedown', onPointerDown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectedModel = useMemo(
    () => findCatalogModel(catalog.kind === 'ready' ? catalog.catalog : undefined, settings.provider, settings.model),
    [catalog, settings.provider, settings.model],
  )

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

  const chooseInherit = (): void => { save({ mode: 'inherit' }) }
  const chooseModel = (provider: string, modelId: string): void => {
    const model = findCatalogModel(catalog.kind === 'ready' ? catalog.catalog : undefined, provider, modelId)
    const effort = resetEffortForModel(model)
    save({
      mode: 'custom',
      provider,
      model: modelId,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
    })
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
  }

  const rows: readonly MenuRow[] = useMemo(() => {
    if (!open) return []
    const list: MenuRow[] = [
      {
        id: 'inherit',
        label: copy('builder.inherit'),
        description: copy('builder.inheritHint'),
        selected: settings.mode !== 'custom',
        action: chooseInherit,
      },
    ]
    if (catalog.kind === 'ready') {
      for (const group of catalog.catalog.groups) {
        for (const model of group.models) {
          list.push({
            id: `model:${group.id}:${model.id}`,
            label: `${model.name} · ${group.name}`,
            ...(model.description === undefined ? {} : { description: model.description }),
            selected: settings.mode === 'custom' && settings.provider === group.id && settings.model === model.id,
            action: () => { chooseModel(group.id, model.id) },
          })
        }
      }
      if (settings.mode === 'custom' && modelHasThinking(selectedModel)) {
        for (const option of thinkingOptions(selectedModel, settings.reasoningEffort)) {
          list.push({
            id: `effort:${option.effort ?? 'default'}`,
            label: option.effort === undefined ? copy('builder.providerDefault') : option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
            selected: option.selected,
            action: () => { chooseEffort(option.effort) },
          })
        }
      }
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, catalog, settings, selectedModel])

  const enabledRows = rows.filter((row) => row.disabled !== true)

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setOpen(false)
      chipRef.current?.focus()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, enabledRows.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const row = enabledRows[activeIndex]
      if (row?.action !== undefined) {
        event.preventDefault()
        row.action()
      }
    }
  }

  if (!visible) return null
  const label = settings.mode === 'custom'
    ? builderChipLabel(settings, selectedModel?.name)
    : copy('builder.inherit')
  const chipLabel = settings.mode === 'custom' ? label : `Builder · ${label}`
  return (
    <div ref={rootRef} className={CLASS.builderControl} style={{ position: 'relative', display: 'inline-flex' }} onKeyDown={onKeyDown}>
      <button
        ref={chipRef}
        type="button"
        className={CLASS.ghost}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabledReason !== undefined}
        title={disabledReason ?? copy('builder.title')}
        onClick={() => { setOpen((value) => !value) }}
      >
        {chipLabel}
        {saving ? ` · ${copy('builder.saving')}` : ''}
        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={copy('builder.title')}
          style={{
            position: 'absolute', bottom: '100%', left: 0, zIndex: 30, marginBottom: 6,
            minWidth: 260, maxWidth: 360, maxHeight: 320, overflowY: 'auto',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
            background: 'var(--dsw-specific-tip)', color: 'var(--dsw-alias-label-primary)',
            padding: 4, display: 'flex', flexDirection: 'column', gap: 1,
            boxShadow: 'var(--dsw-elevation-soft)',
          }}
        >
          <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{copy('builder.models')}</div>
          {catalog.kind === 'loading' ? <div style={{ padding: '6px 8px', fontSize: 12 }}>{copy('builder.loading')}</div> : null}
          {catalog.kind === 'error' ? (
            <div style={{ padding: '6px 8px', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>{copy('builder.error')}</span>
              <button type="button" className={CLASS.ghost} onClick={loadCatalog}>{copy('builder.retry')}</button>
            </div>
          ) : null}
          {rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              role="menuitemradio"
              aria-checked={row.selected}
              disabled={row.disabled === true}
              onMouseEnter={() => { setActiveIndex(index) }}
              onClick={() => { row.action?.() }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
                border: 'none', textAlign: 'left', cursor: 'pointer',
                background: index === activeIndex ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)', borderRadius: 6, padding: '5px 8px', fontSize: 13,
              }}
            >
              <span>{row.selected ? '✓ ' : ''}{row.label}</span>
              {row.description === undefined ? null : (
                <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{row.description}</span>
              )}
            </button>
          ))}
          {catalog.kind === 'ready' && settings.mode === 'custom' && !modelHasThinking(selectedModel) ? (
            <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
              {copy('builder.thinking')}: {copy('builder.notAvailable')}
            </div>
          ) : null}
          {saveError === undefined ? null : (
            <div style={{ padding: '4px 8px', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{copy('builder.saveFailed')}</div>
          )}
        </div>
      ) : null}
    </div>
  )
}
