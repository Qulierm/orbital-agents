/**
 * Shared plan presentation for both surfaces: the durable transcript card and
 * the composer plan dock. Renders only short display data — titles, the four
 * states, progress, timers, and a short note. Detailed execution projections
 * (instructions/validation/constraints) never reach this component because the
 * card data type does not carry them.
 */

import { useEffect, useState, type CSSProperties } from 'react'
import type { EndeavourCardData, EndeavourCardTask } from './definition.js'
import type { EndeavourKey } from './locales.js'

/** Copy lookup shared by both surfaces. */
export type PlanCopy = (key: EndeavourKey, params?: Record<string, string | number>) => string

/** Presentation props. */
export interface PlanViewProps {
  readonly data: EndeavourCardData
  readonly copy: PlanCopy
  readonly onOpenBuilder: () => void
  /** `dock` spans the composer width; `card` is the transcript card. */
  readonly variant?: 'card' | 'dock'
}

/** Format milliseconds as mm:ss, clamped at zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/** Live elapsed for a running task, frozen duration for a terminal one. */
export function taskElapsed(task: EndeavourCardTask, now: number): string | undefined {
  if (task.startedAt === undefined) return undefined
  return formatElapsed((task.finishedAt ?? now) - task.startedAt)
}

const STATUS_COLOR: Record<EndeavourCardTask['status'], string> = {
  waiting: 'var(--dsw-text-tertiary, #8a8f98)',
  running: 'var(--dsw-accent-primary, #4d6bfe)',
  succeeded: 'var(--dsw-status-success, #22c55e)',
  failed: 'var(--dsw-status-error, #ef4444)',
}

/** One plan panel; the timer ticks every second only while a task is running. */
export function PlanView(props: PlanViewProps): React.ReactElement | null {
  const { data, copy, onOpenBuilder, variant = 'card' } = props
  const [now, setNow] = useState(() => Date.now())
  const [collapsed, setCollapsed] = useState(false)
  const active = data.tasks.some((task) => task.status === 'running')
  useEffect(() => {
    if (!active) return undefined
    const handle = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(handle) }
  }, [active])

  const dock = variant === 'dock'
  const container: CSSProperties = {
    boxSizing: 'border-box',
    width: dock ? '100%' : undefined,
    maxWidth: dock ? '100%' : '560px',
    border: '1px solid var(--dsw-border-subtle, #2a2f3a)',
    borderRadius: '10px',
    background: 'var(--dsw-surface-raised, #171a21)',
    color: 'var(--dsw-text-primary, #e6e8ec)',
    padding: dock ? '8px 12px' : '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }
  const progress = copy('plan.progress', { completed: data.completedCount, total: data.total })
  return (
    <section style={container} data-endeavour-plan={data.planId} data-endeavour-surface={variant} aria-label={data.title}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: '10px', minWidth: 0 }}>
        <strong style={{ fontSize: dock ? '13px' : '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {data.title}
        </strong>
        <span style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px', flexShrink: 0 }}>{progress}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? copy('plan.expand') : copy('plan.collapse')}
          onClick={() => { setCollapsed((value) => !value) }}
          style={{ border: 'none', background: 'transparent', color: 'var(--dsw-text-tertiary, #8a8f98)', fontSize: '12px', cursor: 'pointer', padding: 0, flexShrink: 0 }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          type="button"
          onClick={onOpenBuilder}
          style={{ border: '1px solid var(--dsw-border-subtle, #2a2f3a)', background: 'transparent', color: 'var(--dsw-accent-primary, #4d6bfe)', borderRadius: '6px', padding: '3px 9px', fontSize: '12px', cursor: 'pointer', flexShrink: 0 }}
        >
          {copy('plan.openBuilder')}
        </button>
      </header>
      {!collapsed && (data.currentTitle !== undefined || data.checking) && data.terminal === undefined ? (
        <div style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.currentTitle === undefined ? '' : copy('plan.current', { title: data.currentTitle })}
          {data.checking ? `${data.currentTitle === undefined ? '' : ' · '}${copy('plan.checking')}` : ''}
        </div>
      ) : null}
      {!collapsed ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '240px', overflowY: 'auto' }}>
          {data.tasks.map((task) => (
            <li key={task.id} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0', fontSize: '13px', minWidth: 0 }}>
              <span aria-hidden="true" style={{ color: STATUS_COLOR[task.status], fontSize: '11px', flexShrink: 0 }}>●</span>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={task.title}>
                {task.title}
              </span>
              <span style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px', flexShrink: 0 }}>
                {copy(`status.${task.status}` as EndeavourKey)}
              </span>
              {taskElapsed(task, now) !== undefined ? (
                <span style={{ color: 'var(--dsw-text-tertiary, #8a8f98)', fontSize: '12px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }} aria-label={`${task.title} elapsed`}>
                  {taskElapsed(task, now)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.terminal !== undefined ? (
        <div style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {data.terminal.outcome === 'completed' ? copy('plan.completed') : copy('plan.failed')}
          {data.terminal.note !== undefined ? ` — ${data.terminal.note}` : ''}
        </div>
      ) : null}
    </section>
  )
}
