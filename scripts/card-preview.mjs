/** Deterministic plan fixture: native composer context, multiple dock occupants,
    PlanDock last before InputBar, collapsed + expanded surfaces. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('tmp', { recursive: true })

const entry = `
import { createRoot } from 'react-dom/client'
import { PlanView } from '../src/client/PlanView.tsx'
import { PlanDock } from '../src/client/PlanDock.tsx'
import { formatEnglish } from '../src/client/locales.ts'
import { STYLE_TEXT } from '../src/client/styles.ts'

const copy = (key, params) => formatEnglish(key, params)
const now = Date.now()

const active = { planId: 'p-fixture-active', rootSessionId: 'root', title: 'Extension Test Plan', tasks: [
  { id: 't1', title: 'Define test scope', status: 'succeeded', stage: 'confirmed', startedAt: now - 180000, finishedAt: now - 120000 },
  { id: 't2', title: 'Add test fixture for the attached composer dock geometry', status: 'running', stage: 'working', startedAt: now - 110000 },
  { id: 't3', title: 'Verify and summarize', status: 'waiting', stage: 'waiting' },
], completedCount: 1, total: 3, currentTitle: 'Add test fixture for the attached composer dock geometry', checking: false, childId: 'child-1' }

const completed = { planId: 'p-fixture-completed', rootSessionId: 'root', title: 'Extension Test Plan', tasks: [
  { id: 't1', title: 'Define test scope', status: 'succeeded', stage: 'confirmed', startedAt: now - 200000, finishedAt: now - 150000 },
  { id: 't2', title: 'Add test fixture', status: 'succeeded', stage: 'confirmed', startedAt: now - 140000, finishedAt: now - 90000 },
  { id: 't3', title: 'Verify and summarize', status: 'succeeded', stage: 'confirmed', startedAt: now - 80000, finishedAt: now - 30000 },
], completedCount: 3, total: 3, checking: false, terminal: { outcome: 'completed', at: now - 30000 }, childId: 'child-1' }

const dock = (data) => (
  <PlanDock
    useProjection={(key) => (key === 'endeavourPlan' ? data : undefined)}
    t={copy}
    openBuilder={() => {}}
  />
)

/** Other input.dock occupants sort above the plan dock (native todo 0, cost 5). */
const otherOccupant = (label, height) => (
  <div style={{ width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)' }}>
    <div style={{ height, borderRadius: 8, background: '#26262a', color: '#8a8f98', fontSize: 12, display: 'grid', placeItems: 'center' }}>{label}</div>
  </div>
)

/** Native composer context: seat, occupants, PlanDock last, then InputBar.
    withDock=false renders a normal composer that must keep native elevation. */
const composer = (data, withDock = true) => (
  <div data-composer-seat style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--dsh-composer-stack-gap)',
    fontFamily: 'Inter, system-ui, sans-serif',
  }}>
    {otherOccupant('todo strip (native order 0)', 36)}
    {otherOccupant('cost strip (order 5)', 22)}
    {withDock ? dock(data) : null}
    <div style={{ boxSizing: 'border-box', width: '100%', padding: '0 var(--dsh-composer-side-clearance)' }}>
      <div data-composer-card className="fixture-composer-card">Message or run a task, / commands, @ files or sessions</div>
    </div>
  </div>
)

const fixture = () => (
  <div style={{ background: '#0f1115', minHeight: '100vh', padding: '24px 0', display: 'grid', gap: 32,
    '--dsh-chat-content-width': '680px',
    '--dsh-composer-card-max-width': 'calc(var(--dsh-chat-content-width) + 32px)',
    '--dsh-composer-side-clearance': '16px',
    '--dsh-composer-stack-gap': '6px',
    '--dsw-specific-tip': '#1b1e25',
    '--dsw-specific-input-major': '#2c2c2e',
    '--dsw-alias-label-primary': '#e6e8ec',
    '--dsw-alias-label-secondary': '#a6adbb',
    '--dsw-alias-label-tertiary': '#8a8f98',
    '--dsw-alias-label-caption': '#6b7280',
    '--dsw-alias-border-l1': 'rgba(255,255,255,0.08)',
    '--dsw-alias-border-l2': 'rgba(255,255,255,0.12)',
    '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,0.05)',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-error-primary': '#ef4444',
    '--dsw-alias-state-business-primary': '#4d6bfe',
    '--dsw-elevation-stroke-color': 'rgba(255,255,255,0.14)',
    '--dsw-elevation-soft': '0 0 0 0.5px var(--dsw-elevation-stroke-color), 0 12px 32px rgba(0,0,0,0.24), 0 2px 8px rgba(0,0,0,0.18)',
  }}>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>wide composer — completed plan (collapsed default)</div>
    <div style={{ width: 1280, margin: '0 auto' }}>{composer(completed)}</div>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>wide composer — active plan (expanded)</div>
    <div style={{ width: 1280, margin: '0 auto' }}>{composer(active)}</div>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>narrow composer — active plan (expanded)</div>
    <div style={{ width: 640, margin: '0 auto' }}>{composer(active)}</div>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>normal composer — no plan dock (native elevation preserved)</div>
    <div style={{ width: 1280, margin: '0 auto' }}>{composer(active, false)}</div>
  </div>
)

const style = document.createElement('style')
style.textContent = STYLE_TEXT
document.head.appendChild(style)
const fixtureStyle = document.createElement('style')
fixtureStyle.textContent = '.fixture-composer-card { box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width); margin: 0 auto; border-radius: 22px; background: var(--dsw-specific-input-major); box-shadow: var(--dsw-elevation-soft); color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 24px; padding: 8px 12px 10px; }'
document.head.appendChild(fixtureStyle)

const root = createRoot(document.getElementById('root'))
root.render(fixture())
`

writeFileSync('tmp/card-preview.entry.tsx', entry)
await build({
  entryPoints: ['tmp/card-preview.entry.tsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  minify: true,
  outfile: 'tmp/card-preview.bundle.js',
  loader: { '.tsx': 'tsx' },
})

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Endeavour dock fixture</title></head>
<body style="margin:0;background:#0f1115"><div id="root"></div><script src="./card-preview.bundle.js"></script></body></html>`
writeFileSync('tmp/card-preview.html', html)
console.log('card-preview written to tmp/card-preview.html')
