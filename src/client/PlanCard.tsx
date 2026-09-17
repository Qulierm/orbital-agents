/** Keyed Chat renderer for the Endeavour plan card. */

import { useEffect, useState, type CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { TASK_STATUS_PHRASES } from '../domain.js'
import type { EndeavourCardData, EndeavourCardTask } from './definition.js'
import { ru, type EndeavourKey } from './locales.js'

/** Navigation injected from the plugin's own Session Controller access. */
export interface EndeavourInjected {
  readonly openSession: (id: SessionId) => void
}

/** Complete keyed Chat renderer props. */
export type PlanCardProps =
  PropsRuntime<'conversation.chat.node', 'endeavour-plan'>
  & PropsLocale<'endeavour'>
  & EndeavourInjected

const STATUS_COLOR: Record<EndeavourCardTask['status'], string> = {
  waiting: 'var(--dsw-text-tertiary, #8a8f98)',
  running: 'var(--dsw-accent-primary, #4d6bfe)',
  succeeded: 'var(--dsw-status-success, #22c55e)',
  failed: 'var(--dsw-status-error, #ef4444)',
}

function cardData(props: PlanCardProps): EndeavourCardData | undefined {
  const node = (props as { readonly node?: ChatConversationViewNode }).node
  return node?.data as EndeavourCardData | undefined
}

function copy(props: PlanCardProps, key: EndeavourKey): string {
  const translate = (props as { readonly t?: (key: string, params?: Record<string, unknown>) => string }).t
  if (typeof translate === 'function') return translate(key)
  return ru[key]
}

/** Format milliseconds as mm:ss, clamped at zero. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function elapsedOf(task: EndeavourCardTask, now: number): string | undefined {
  if (task.startedAt === undefined) return undefined
  return formatElapsed((task.finishedAt ?? now) - task.startedAt)
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  padding: '4px 0',
  color: 'var(--dsw-text-primary, #e6e8ec)',
  fontSize: '13px',
}

/** One plan card; the timer ticks every second only while a task is running. */
export function PlanCard(props: PlanCardProps): React.ReactElement | null {
  const data = cardData(props)
  const [now, setNow] = useState(() => Date.now())
  const active = data?.tasks.some((task) => task.status === 'running') ?? false
  useEffect(() => {
    if (!active) return undefined
    const handle = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(handle) }
  }, [active])
  if (data === undefined) return null
  const container: CSSProperties = {
    border: '1px solid var(--dsw-border-subtle, #2a2f3a)',
    borderRadius: '10px',
    background: 'var(--dsw-surface-raised, #171a21)',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    maxWidth: '560px',
  }
  return (
    <section style={container} data-endeavour-plan={data.planId} aria-label={copy(props, 'plan.title')}>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
        <strong style={{ color: 'var(--dsw-text-primary, #e6e8ec)', fontSize: '14px' }}>{data.title}</strong>
        <span style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px' }}>
          {copy(props, 'plan.progress').replace('{completed}', String(data.completedCount)).replace('{total}', String(data.total))}
        </span>
      </header>
      {data.currentTitle !== undefined && data.terminal === undefined ? (
        <div style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px' }}>
          {copy(props, 'plan.current').replace('{title}', data.currentTitle)}
          {data.checking ? ` · ${copy(props, 'plan.checking')}` : ''}
        </div>
      ) : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {data.tasks.map((task) => (
          <li key={task.id} style={rowStyle}>
            <span aria-hidden="true" style={{ color: STATUS_COLOR[task.status], fontSize: '11px' }}>●</span>
            <span style={{ flex: 1 }}>{task.title}</span>
            <span style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px' }}>
              {TASK_STATUS_PHRASES[task.status]}
            </span>
            {elapsedOf(task, now) !== undefined ? (
              <span style={{ color: 'var(--dsw-text-tertiary, #8a8f98)', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                {elapsedOf(task, now)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {data.terminal !== undefined ? (
        <div style={{ color: 'var(--dsw-text-secondary, #a6adbb)', fontSize: '12px' }}>
          {data.terminal.outcome === 'completed' ? copy(props, 'plan.completed') : copy(props, 'plan.failed')}
          {data.terminal.note !== undefined ? ` — ${data.terminal.note}` : ''}
        </div>
      ) : null}
      <div>
        <button
          type="button"
          onClick={() => { props.openSession(data.childId as SessionId) }}
          style={{
            border: '1px solid var(--dsw-border-subtle, #2a2f3a)',
            background: 'transparent',
            color: 'var(--dsw-accent-primary, #4d6bfe)',
            borderRadius: '6px',
            padding: '4px 10px',
            fontSize: '12px',
            cursor: 'pointer',
          }}
        >
          {copy(props, 'plan.openBuilder')}
        </button>
      </div>
    </section>
  )
}
