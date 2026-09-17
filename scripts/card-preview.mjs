/** Deterministic plan fixture: native composer context, wide + narrow widths. */

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

const active = { planId: 'p-fixture-active', title: 'Extension Test Plan', tasks: [
  { id: 't1', title: 'Define test scope', status: 'succeeded', startedAt: now - 180000, finishedAt: now - 120000 },
  { id: 't2', title: 'Add test fixture for the attached composer dock geometry', status: 'running', startedAt: now - 110000 },
  { id: 't3', title: 'Verify and summarize', status: 'waiting' },
], completedCount: 1, total: 3, currentTitle: 'Add test fixture for the attached composer dock geometry', checking: false, childId: 'child-1' }

const checking = { ...active, planId: 'p-fixture-checking', checking: true }
const failed = { planId: 'p-fixture-failed', title: 'Extension Test Plan', tasks: [
  { id: 't1', title: 'Define test scope', status: 'succeeded', startedAt: now - 200000, finishedAt: now - 150000 },
  { id: 't2', title: 'Apply the fix', status: 'failed', startedAt: now - 140000, finishedAt: now - 30000, note: 'Verification did not pass' },
], completedCount: 1, total: 2, checking: false, terminal: { outcome: 'failed', at: now - 30000, note: 'Verification did not pass' }, childId: 'child-1' }

const dock = (data) => (
  <PlanDock
    useChat={(selector) => selector({ nodes: { values: () => [{ key: 'n', kind: 'endeavour-plan', id: data.planId, target: 'chat', anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible', data }] } })}
    t={copy}
    openSession={() => {}}
  />
)

/** Native composer context: the variables ConversationRoot publishes. */
const composer = (active_data) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--dsh-composer-stack-gap)',
    padding: '0 var(--dsh-composer-side-clearance)', fontFamily: 'Inter, system-ui, sans-serif',
  }}>
    {dock(active_data)}
    <div style={{
      width: '100%', maxWidth: 'var(--dsh-composer-card-max-width)', boxSizing: 'border-box',
      borderRadius: '22px', background: 'var(--dsw-specific-input-major)', padding: '8px 12px 10px',
      color: 'var(--dsw-alias-label-tertiary)', fontSize: 14, lineHeight: '24px',
    }}>Message or run a task, / commands, @ files or sessions</div>
  </div>
)

const fixture = () => (
  <div style={{ background: '#0f1115', minHeight: '100vh', padding: '24px 0', display: 'grid', gap: 32,
    '--dsh-chat-content-width': '640px',
    '--dsh-composer-card-max-width': 'calc(var(--dsh-chat-content-width) + 32px)',
    '--dsh-composer-side-clearance': '16px',
    '--dsh-composer-dock-inset': '8px',
    '--dsh-composer-stack-gap': '6px',
    '--dsw-specific-tip': '#1b1e25',
    '--dsw-specific-input-major': '#22262f',
    '--dsw-alias-label-primary': '#e6e8ec',
    '--dsw-alias-label-secondary': '#a6adbb',
    '--dsw-alias-label-tertiary': '#8a8f98',
    '--dsw-alias-label-caption': '#6b7280',
    '--dsw-alias-border-l1': 'rgba(255,255,255,0.08)',
    '--dsw-alias-border-l2': 'rgba(255,255,255,0.12)',
    '--dsw-alias-interactive-bg-hover': 'rgba(255,255,255,0.05)',
    '--dsw-alias-state-success-primary': '#22c55e',
    '--dsw-alias-state-error-primary': '#ef4444',
    '--dsw-alias-state-business-primary': '#4d6bfe' }}>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>wide composer (1280 viewport)</div>
    <div style={{ width: 1280, margin: '0 auto' }}>{composer(active)}</div>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>narrow composer (640 viewport)</div>
    <div style={{ width: 640, margin: '0 auto' }}>{composer(active)}</div>
    <div style={{ color: '#8a8f98', fontSize: 12, textAlign: 'center' }}>checking + failed transcript cards</div>
    <div style={{ width: 640, margin: '0 auto', display: 'grid', gap: 12 }}>
      <PlanView data={checking} copy={copy} onOpenBuilder={() => {}} variant="card" />
      <PlanView data={failed} copy={copy} onOpenBuilder={() => {}} variant="card" />
    </div>
  </div>
)

const style = document.createElement('style')
style.textContent = STYLE_TEXT
document.head.appendChild(style)
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
