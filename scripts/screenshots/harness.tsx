/**
 * Offline screenshot harness.
 *
 * Renders the REAL client components (`PlanView`, `ChallengerModelControl`) against
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
  ChallengerModelControl,
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
        { id: 'long', name: 'Extended Reasoning Preview (OG) Build', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
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

const EMPTY_PENDING_SNAPSHOT = Object.freeze({})

function pendingController(): UnifiedModelController['pendingSelection'] {
  return {
    getSnapshot: () => EMPTY_PENDING_SNAPSHOT,
    subscribe: () => () => undefined,
    save: async (selection) => ({ schemaVersion: 1, revision: 'fixture', ...selection }),
    removeIfRevision: async () => false,
  }
}

const PAIRED_SOURCE = Object.freeze({ mode: 'peer' as const, key: `peer:${CHALLENGER_SESSION}`, generation: 1, peerId: CHALLENGER_SESSION })
const DRAFT_SOURCE = Object.freeze({ mode: 'draft' as const, key: `draft:${ENDEAVOUR_SESSION}`, generation: 1 })

/** The same bridge with one deliberately long peer model name, for layout checks. */
const longNameController: UnifiedModelController = {
  roles: {
    endeavour: roleController({ provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' }),
    challenger: roleController({ provider: 'provider-a', model: 'long', reasoningEffort: 'high' }),
  },
  sourceSnapshot: () => PAIRED_SOURCE,
  subscribeSource: () => () => undefined,
  pendingSelection: pendingController(),
  applyPendingToPeer: async () => false,
  admit: () => true,
}

const controller: UnifiedModelController = {
  roles: {
    endeavour: roleController({ provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' }),
    challenger: roleController({ provider: 'provider-a', model: 'compact' }),
  },
  sourceSnapshot: () => PAIRED_SOURCE,
  subscribeSource: () => () => undefined,
  pendingSelection: pendingController(),
  applyPendingToPeer: async () => false,
  admit: () => true,
}

const draftController: UnifiedModelController = {
  roles: {
    endeavour: roleController({ provider: 'provider-a', model: 'reasoner', reasoningEffort: 'high' }),
    challenger: roleController({ provider: 'provider-a', model: 'compact' }),
  },
  sourceSnapshot: () => DRAFT_SOURCE,
  subscribeSource: () => () => undefined,
  pendingSelection: pendingController(),
  applyPendingToPeer: async () => false,
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

/**
 * The Challenger selector beside a clearly marked NATIVE-selector fixture: the
 * offline composition check shows the host's own Endeavour button next to the
 * custom one, exactly as the model seat lays them out.
 */
/**
 * Native-selector reference, NOT the real DSH component.
 *
 * ModelSelect is not publicly exported and its class names are hashed, so this
 * fixture reproduces the installed geometry from
 * `dsh-client-ui-model-selection`'s own stylesheet: 28px trigger, 13/20 regular,
 * 4px gap, `0 4px 0 8px` padding, `--dsw-radius-sm`, secondary label, and a
 * caption chevron. It exists only for offline measurement beside the custom
 * control and is marked `data-native-selector-fixture` so no capture can be
 * mistaken for live Desktop evidence.
 */
function nativeReference(options: { readonly long?: boolean; readonly menu?: boolean; readonly menuOffset?: number } = {}): React.ReactElement {
  const label = options.long === true ? 'GPT-5.6 Sol Extended Reasoning' : 'GPT-5.6 Sol High'
  return (
    <div data-native-selector-fixture="" style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        data-native-model-selector=""
        title="Native ModelSelect reference (fixture)"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          height: 28,
          minWidth: 0,
          maxWidth: 'min(360px, 45cqw)',
          padding: '0 4px 0 8px',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: 13,
          fontWeight: 400,
          lineHeight: '20px',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            minWidth: 0,
            // A native trigger never wraps: the label ellipsises instead.
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none', color: 'var(--dsw-alias-label-caption)' }}>
          <path d="M4 6.5 8 10.5l4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {options.menu === true ? (
        <div
          data-native-menu-fixture=""
          data-menu-material="translucent"
          style={{
            position: 'absolute',
            top: 34,
            // Offset so the two cards sit side by side for measurement instead of
            // overlapping each other.
            left: options.menuOffset ?? 0,
            zIndex: 1100,
            display: 'flex',
            flexDirection: 'column',
            width: 'max-content',
            minWidth: 'min(240px, calc(100vw - 32px))',
            maxWidth: 'min(420px, calc(100vw - 32px))',
            padding: 4,
            border: 0,
            borderRadius: 'var(--dsw-radius-lg)',
            background: 'var(--dsw-menu-surface-fill)',
            boxShadow: 'var(--dsw-elevation-prominent)',
            color: 'var(--dsw-alias-label-primary)',
            isolation: 'isolate',
          }}
        >
          {[
            { label: 'Model', value: 'GPT-5.6 Sol' },
            { label: 'Effort', value: 'High' },
          ].map((row) => (
            <div
              key={row.label}
              style={{
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                minWidth: '100%',
                height: 34,
                padding: '0 8px',
                borderRadius: 'var(--dsw-radius-md)',
                color: 'var(--dsw-alias-label-primary)',
                fontSize: 13,
                lineHeight: '20px',
              }}
            >
              <span style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>{row.label}</span>
              <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' }}>{row.value}</span>
              <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flex: 'none', color: 'var(--dsw-alias-menu-icon)' }}>
                <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function modelControl(options: { readonly long?: boolean; readonly narrow?: boolean; readonly referenceMenu?: boolean; readonly draft?: boolean; readonly activeWork?: boolean } = {}): React.ReactElement {
  const props = {
    sessionId: ENDEAVOUR_SESSION,
    unifiedModels: options.long === true ? longNameController : options.draft === true ? draftController : controller,
    // The peer fixture passes the same deterministic state accepted by the app's validator.
    useProjection: (key: string) => (key === 'agentPreset' ? 'endeavour' : key === 'endeavourPeer' ? options.draft === true ? undefined : PEER : undefined),
    useSession: (select: (snapshot: { readonly running: boolean }) => unknown) => select({ running: options.activeWork === true }),
  }
  const Component = ChallengerModelControl as unknown as (input: typeof props) => React.ReactElement | null
  const seat = (
    <div data-model-seat="" {...(options.activeWork === true ? { 'data-active-work-scene': '' } : {})} style={{ display: 'flex', alignItems: 'center', gap: 4, ...(options.narrow === true ? { maxWidth: 230, overflow: 'hidden' } : {}) }}>
      <div data-slot="conversation.input.right" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}><Component {...props} /></div>
      <div data-slot="conversation.input.model" style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        {nativeReference({ ...(options.long === true ? { long: true } : {}), ...(options.referenceMenu === true ? { menu: true, menuOffset: 370 } : {}) })}
      </div>
    </div>
  )
  return options.activeWork === true
    ? <div data-scene-active-work="">{planView(runningPlan(), 'card')}{seat}</div>
    : seat
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
        {modelControl()}
      </div>
    </div>
  )
}

const SCENES: Record<string, () => React.ReactElement> = {
  'plan-running': () => planView(runningPlan(), 'card'),
  'plan-interrupted': () => planView(interruptedPlan(), 'card', 'interrupted'),
  'plan-complete': () => planView(completePlan(), 'card'),
  'challenger-controls': () => modelControl(),
  'challenger-no-peer': () => modelControl({ draft: true }),
  'challenger-active-work': () => modelControl({ activeWork: true }),
  'challenger-measure': () => modelControl({ referenceMenu: true }),
  'challenger-menu': () => modelControl({ referenceMenu: true }),
  'challenger-menu-neutral': () => modelControl({ referenceMenu: true }),
  'challenger-menu-keyboard': () => modelControl(),
  'challenger-narrow': () => modelControl({ long: true, narrow: true }),
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
    // Reports the geometry the browser actually computes for both the custom
    // control and the native reference, so offline evidence is measured.
    'challenger-measure': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
      if (trigger instanceof HTMLElement) trigger.click()
      const read = (element: Element | null, keys: readonly string[]): Record<string, string> => {
        if (element === null) return { missing: 'true' }
        const style = getComputedStyle(element)
        const box = element.getBoundingClientRect()
        const out: Record<string, string> = {
          width: box.width.toFixed(1),
          height: box.height.toFixed(1),
        }
        for (const key of keys) out[key] = style.getPropertyValue(key).trim()
        return out
      }
      const readOutline = (element: Element | null): Record<string, string> => {
        if (element === null) return { missing: 'true' }
        const style = getComputedStyle(element)
        return {
          strokeColor: style.getPropertyValue('--dsw-elevation-stroke-color').trim(),
          boxShadow: style.boxShadow,
        }
      }
      const pre = document.createElement('pre')
      pre.setAttribute('data-measure', '')
      pre.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:1200;max-width:744px;max-height:380px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#151517;color:#fff;padding:8px;font:10px/1.25 monospace'
      // The popup is portaled by React, so it exists only after the commit that
      // the click scheduled: measure on the next task, not synchronously.
      setTimeout(() => {
        const customMenu = document.querySelector('[data-endeavour-challenger-pane]')
        const nativeMenu = document.querySelector('[data-native-menu-fixture]')
        const dark = { custom: readOutline(customMenu), reference: readOutline(nativeMenu) }
        document.body.removeAttribute('data-ds-dark-theme')
        const light = { custom: readOutline(customMenu), reference: readOutline(nativeMenu) }
        document.body.setAttribute('data-ds-dark-theme', '')
        const customGeometry = read(customMenu, ['border-radius', 'padding', 'width'])
        const customRow = read(document.querySelector('[data-endeavour-challenger-pane] [role="menuitem"]'), ['height', 'font-size', 'line-height', 'padding', 'gap', 'border-radius'])
        const referenceGeometry = read(nativeMenu, ['border-radius', 'padding', 'width'])
        const referenceRow = read(document.querySelector('[data-native-menu-fixture] > div'), ['height', 'font-size', 'line-height', 'padding', 'gap', 'border-radius'])
        pre.textContent = [
          `dark custom: ${dark.custom.strokeColor}; ${dark.custom.boxShadow}`,
          `dark reference: ${dark.reference.strokeColor}; ${dark.reference.boxShadow}`,
          `light custom: ${light.custom.strokeColor}; ${light.custom.boxShadow}`,
          `light reference: ${light.reference.strokeColor}; ${light.reference.boxShadow}`,
          `geometry custom: radius ${customGeometry['border-radius']}, row ${customRow.height}; reference: radius ${referenceGeometry['border-radius']}, row ${referenceRow.height}`,
        ].join('\n')
      }, 0)
      document.body.appendChild(pre)
    },
    // The pointer stays untouched so the first root row has no hover highlight.
    'challenger-menu-neutral': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
      if (trigger instanceof HTMLElement) trigger.click()
    },
    // Show keyboard focus on the first enabled row without choosing it.
    'challenger-menu-keyboard': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
      if (trigger instanceof HTMLElement) trigger.click()
      // Passive menu listeners attach after the open-menu commit.
      setTimeout(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) }, 0)
    },
    // The root can save choices before the validated peer exists.
    'challenger-no-peer': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
      if (trigger instanceof HTMLElement) trigger.click()
    },
    // An active plan leaves the Challenger selector enabled and open.
    'challenger-active-work': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
      if (trigger instanceof HTMLElement) trigger.click()
    },
    // The popup is portaled and only exists while open.
    'challenger-menu': () => {
      const trigger = document.querySelector('[data-endeavour-challenger-models]')
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
