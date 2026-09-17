/**
 * Shared plan presentation for both surfaces: the durable transcript card and
 * the composer plan dock. Renders only short display data — titles, the four
 * states, progress, timers, and a short note. Detailed execution projections
 * (instructions/validation/constraints) never reach this component because the
 * card data type does not carry them.
 */

import { useEffect, useState } from 'react'
import type { EndeavourCardData, EndeavourCardTask } from './definition.js'
import type { EndeavourKey } from './locales.js'
import { CLASS } from './styles.js'

/** Copy lookup shared by both surfaces. */
export type PlanCopy = (key: EndeavourKey, params?: Record<string, string | number>) => string

/** Presentation props. */
export interface PlanViewProps {
  readonly data: EndeavourCardData
  readonly copy: PlanCopy
  readonly onOpenBuilder: () => void
  /** `dock` attaches above the composer; `card` is the transcript card. */
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

/** Pending: hollow dashed ring, matching the native todo glyph. */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

/** Running: business-blue partial ring with a subtle pulsing core. */
function RunningGlyph() {
  return (
    <span className={CLASS.pulse} style={{ display: 'grid', placeItems: 'center' }}>
      <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="26 14" strokeLinecap="round" />
        <circle cx="7" cy="7" r="2.2" fill="currentColor" opacity="0.5" />
      </svg>
    </span>
  )
}

/** Succeeded: success check-ring. */
function SucceededGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.4 7.2 6.2 9l3.6-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Failed: failure mark. */
function FailedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

const GLYPH_CLASS: Record<EndeavourCardTask['status'], string> = {
  waiting: CLASS.glyphPending,
  running: CLASS.glyphRunning,
  succeeded: CLASS.glyphSucceeded,
  failed: CLASS.glyphFailed,
}

function StatusGlyph({ status }: { status: EndeavourCardTask['status'] }) {
  const body = status === 'waiting'
    ? <PendingGlyph />
    : status === 'running'
      ? <RunningGlyph />
      : status === 'succeeded'
        ? <SucceededGlyph />
        : <FailedGlyph />
  return <span className={`${CLASS.glyph} ${GLYPH_CLASS[status]}`} aria-hidden="true">{body}</span>
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
  const body = (
    <>
      <div className={CLASS.header}>
        <span className={CLASS.title} title={data.title}>{data.title}</span>
        <span className={CLASS.progress}>{copy('plan.progress', { completed: data.completedCount, total: data.total })}</span>
        <button
          type="button"
          className={CLASS.chevron}
          aria-expanded={!collapsed}
          aria-label={collapsed ? copy('plan.expand') : copy('plan.collapse')}
          onClick={() => { setCollapsed((value) => !value) }}
        >
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}>
            <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className={CLASS.ghost} onClick={onOpenBuilder}>
          {copy('plan.openBuilder')}
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {!collapsed ? (
        <ul className={CLASS.rows}>
          {data.tasks.map((task) => (
            <li
              key={task.id}
              className={`${CLASS.row}${task.status === 'running' ? ` ${CLASS.rowRunning}` : ''}`}
            >
              <StatusGlyph status={task.status} />
              <span className={CLASS.rowTitle} title={task.title}>{task.title}</span>
              <span className={CLASS.rowStatus}>
                {copy(`status.${task.status}` as EndeavourKey)}
                {task.status === 'running' && data.checking ? ` · ${copy('plan.checking')}` : ''}
              </span>
              {taskElapsed(task, now) !== undefined ? (
                <span className={CLASS.rowTimer} aria-label={`${task.title} elapsed`}>{taskElapsed(task, now)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {data.terminal !== undefined ? (
        <div className={CLASS.note}>
          {data.terminal.outcome === 'completed' ? copy('plan.completed') : copy('plan.failed')}
          {data.terminal.note !== undefined ? ` — ${data.terminal.note}` : ''}
        </div>
      ) : null}
    </>
  )

  if (!dock) {
    return <section className={CLASS.card} data-endeavour-plan={data.planId} data-endeavour-surface="card" aria-label={data.title}>{body}</section>
  }
  return (
    <div className={CLASS.dockWrap}>
      <section className={CLASS.dockPanel} data-endeavour-plan={data.planId} data-endeavour-surface="dock" aria-label={data.title}>
        {body}
      </section>
    </div>
  )
}
