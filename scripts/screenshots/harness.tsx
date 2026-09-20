/**
 * Offline screenshot harness.
 *
 * Renders the REAL client components (`PlanView`, `UnifiedModelControl`) against
 * synthetic fixture data so the marketplace screenshots show exactly what the
 * plugin draws, without touching the running app, the network or any user data.
 *
 * The scene is selected by `location.hash`. `Date.now` is frozen before the
 * first render so every timer string is deterministic. Nothing here ships in the
 * published package: `assets/` and `scripts/screenshots/` are outside the
 * `files` allowlist.
 */

import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { EndeavourCardData, EndeavourCardTask } from '../../src/plan-projection.js'
import { PlanView } from '../../src/client/PlanView.js'
import {
  UnifiedModelControl,
  type UnifiedCatalog,
  type UnifiedModelController,
  type UnifiedRoleController,
  type UnifiedSelection,
} from '../../src/client/UnifiedModelControl.js'
import { formatEnglish, type EndeavourKey } from '../../src/client/locales.js'
import { ensurePlanStyles } from '../../src/client/styles.js'
import { challengerSessionIdFor, peerPairIdFor, PEER_STATE_VERSION, type PeerState } from '../../src/peer.js'

/** One fixed epoch: every rendered timer is identical on every capture. */
const FROZEN_NOW = 1_700_000_000_000

/** Synthetic plan copy used by every fixture: plugin-domain text only. */
const TITLE = 'Harden the plan projection'

/** Fixture session ids and the peer state the real validator accepts. */
const ENDEAVOUR_SESSION = 'session-fixture-endeavour'
const CHALLENGER_SESSION = challengerSessionIdFor(ENDEAVOUR_SESSION)

const PEER: PeerState = {
  version: PEER_STATE_VERSION,
  pairId: peerPairIdFor(ENDEAVOUR_SESSION),
  endeavourSessionId: ENDEAVOUR_SESSION,
  challengerSessionId: CHALLENGER_SESSION,
  createdAt: FROZEN_NOW - 600_000,
  updatedAt: FROZEN_NOW - 600_000,
  sequence: 1,
}

const copy = (key: EndeavourKey, params?: Record<string, string | number>): string => formatEnglish(key, params)

function task(
  id: string,
  title: string,
  stage: EndeavourCardTask['stage'],
  extra: Partial<EndeavourCardTask> = {},
): EndeavourCardTask {
  const status = stage === 'confirmed' ? 'succeeded' : stage === 'failed' ? 'failed' : stage === 'waiting' ? 'waiting' : 'running'
  return { id, title, status, stage, ...extra }
}

/** A running plan: confirmed, finished, working, and two waiting rows. */
function runningPlan(): EndeavourCardData {
  const tasks: EndeavourCardTask[] = [
    task('t1', 'Inspect projection state', 'confirmed', { startedAt: FROZEN_NOW - 620_000, finishedAt: FROZEN_NOW - 540_000, reportedAt: FROZEN_NOW - 540_000 }),
    task('t2', 'Add durable statuses', 'finished', { startedAt: FROZEN_NOW - 540_000, reportedAt: FROZEN_NOW - 300_000 }),
    task('t3', 'Verify release artifact', 'working', { startedAt: FROZEN_NOW - 65_000 }),
    task('t4', 'Document the panel', 'waiting'),
    task('t5', 'Capture the summary', 'waiting'),
  ]
  return {
    planId: 'fixture-plan',
    rootSessionId: ENDEAVOUR_SESSION,
    title: TITLE,
    tasks,
    completedCount: 1,
    total: tasks.length,
    currentTitle: 'Verify release artifact',
    checking: false,
    childId: CHALLENGER_SESSION,
    challengerSessionId: CHALLENGER_SESSION,
    pairId: PEER.pairId,
    executionTaskId: 't3',
    planReadyDelivered: true,
  }
}

/** The same plan with the paired Challenger stopped mid-task. */
function interruptedPlan(): EndeavourCardData {
  return { ...runningPlan(), title: TITLE }
}

/** A terminal, fully confirmed plan. */
function completePlan(): EndeavourCardData {
  const tasks: EndeavourCardTask[] = runningPlan().tasks.map((row) => ({
    ...row,
    status: 'succeeded' as const,
    stage: 'confirmed' as const,
    startedAt: row.startedAt ?? FROZEN_NOW - 400_000,
    finishedAt: FROZEN_NOW - 120_000,
    reportedAt: row.reportedAt ?? FROZEN_NOW - 200_000,
  }))
  const { currentTitle: _title, executionTaskId: _cursor, ...rest } = runningPlan()
  return {
    ...rest,
    tasks,
    completedCount: tasks.length,
    checking: false,
    terminal: { outcome: 'completed', at: FROZEN_NOW - 60_000 },
  }
}

const CATALOG: UnifiedCatalog = {
  groups: [
    {
      id: 'provider-a',
      models: [
        { id: 'reasoner', name: 'Reasoner Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
        { id: 'compact', name: 'Compact Fast' },
      ],
    },
    {
      id: 'provider-b',
      models: [{ id: 'nano', name: 'Nano Lite', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }],
    },
  ],
} as UnifiedCatalog

function roleController(selection: UnifiedSelection): UnifiedRoleController {
  return {
    available: () => true,
    readSelection: () => selection,
    subscribeSelection: () => () => undefined,
    loadCatalog: async () => CATALOG,
    select: async () => undefined,
  }
}

const controller: UnifiedModelController = {
  roles: {
    endeavour: roleController({ provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' }),
    challenger: roleController({ provider: 'provider-a', model: 'compact' }),
  },
  admit: () => true,
}

function planView(data: EndeavourCardData, variant: 'card' | 'dock', activity?: 'interrupted'): React.ReactElement {
  return (
    <PlanView
      data={data}
      copy={copy}
      onOpenBuilder={() => undefined}
      action={{ kind: 'peer', target: CHALLENGER_SESSION, role: 'challenger' }}
      variant={variant}
      {...(activity === undefined ? {} : { activity })}
    />
  )
}

function modelControl(): React.ReactElement {
  const props = {
    sessionId: ENDEAVOUR_SESSION,
    unifiedModels: controller,
    // The real validator must accept the fixture, so the harness feeds the same
    // deterministic pair the app would produce for this session.
    useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : key === 'endeavourPeer' ? PEER : undefined),
  }
  const Component = UnifiedModelControl as unknown as (input: typeof props) => React.ReactElement | null
  return <Component {...props} />
}

/** Mock composer card: the dock variant above the unified trigger, as in the app. */
function composerCard(): React.ReactElement {
  return (
    <div data-composer-card="" style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {planView(runningPlan(), 'dock')}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          borderRadius: 12,
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-specific-input-major)',
        }}
      >
        <span style={{ flex: 1, color: 'var(--dsw-alias-label-tertiary)' }}>Ask anything, or describe the next task</span>
        <div data-slot="conversation.input.right" style={{ display: 'flex', alignItems: 'center' }}>
          {modelControl()}
        </div>
      </div>
    </div>
  )
}

const SCENES: Record<string, () => React.ReactElement> = {
  'plan-running': () => planView(runningPlan(), 'card'),
  'plan-interrupted': () => planView(interruptedPlan(), 'card', 'interrupted'),
  'plan-complete': () => planView(completePlan(), 'card'),
  'model-menu': () => modelControl(),
  'composer-dock': () => composerCard(),
}

/** Scene names this harness can render; the capture script iterates them. */
export const SCENE_NAMES = Object.keys(SCENES)

function sceneName(): string {
  const hash = window.location.hash.replace(/^#/, '')
  return hash === '' ? 'plan-running' : hash
}

function mount(): void {
  // Freeze the clock BEFORE the first render so the mm:ss timers are stable.
  const RealDate = Date
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(FROZEN_NOW)
      else super(...(args as [number]))
    }
    static override now(): number {
      return FROZEN_NOW
    }
  }
  ;(globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor

  ensurePlanStyles()
  document.body.toggleAttribute('data-ds-dark-theme', true)
  const container = document.getElementById('root')
  if (container === null) throw new Error('screenshot harness: #root is missing')
  const name = sceneName()
  const scene = SCENES[name]
  if (scene === undefined) throw new Error(`screenshot harness: unknown scene ${JSON.stringify(name)}`)
  container.className = 'scene'
  const root = createRoot(container)
  // flushSync renders synchronously, so the scene (and the trigger) exist before
  // the scene script below runs.
  flushSync(() => { root.render(scene()) })

  // Scene scripts run after mount so a still image can show an interactive state.
  const afterMount: Record<string, () => void> = {
    // The menu is portaled and only exists while open.
    'model-menu': () => {
      const trigger = document.querySelector('[data-endeavour-unified-models]')
      if (trigger instanceof HTMLElement) trigger.click()
    },
    // A successfully terminal plan mounts collapsed by design; expand it so the
    // image shows the confirmed rows rather than only the header.
    'plan-complete': () => {
      const toggle = document.querySelector('.dsh-endeavour-card-header button, [aria-label][aria-expanded]')
      if (toggle instanceof HTMLElement) toggle.click()
    },
  }
  const script = afterMount[name]
  if (script !== undefined) {
    // Run inside flushSync so the interactive state (open menu, expanded card) is
    // committed, and let effects plus promise callbacks settle before capture.
    flushSync(script)
    const settle = (): void => {
      flushSync(() => undefined)
      if (document.readyState === 'complete') return
      setTimeout(settle, 16)
    }
    setTimeout(settle, 0)
  }
}

mount()
