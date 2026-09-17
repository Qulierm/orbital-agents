/** Deterministic plan fixture: English card + composer dock surfaces. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('tmp', { recursive: true })

const entry = `
import { createRoot } from 'react-dom/client'
import { PlanView } from '../src/client/PlanView.tsx'
import { PlanDock } from '../src/client/PlanDock.tsx'
import { formatEnglish } from '../src/client/locales.ts'

const now = Date.now()
const copy = (key, params) => formatEnglish(key, params)

const active = { planId: 'p-fixture-active', title: 'Endeavour plan: acceptance fix', tasks: [
  { id: 't1', title: 'Scope orchestration tools to the preset', status: 'succeeded', startedAt: now - 180000, finishedAt: now - 120000 },
  { id: 't2', title: 'Harden the receiver path for proxied Cordis service calls without binding methods', status: 'running', startedAt: now - 110000 },
  { id: 't3', title: 'Document the composer dock flow', status: 'waiting' },
], completedCount: 1, total: 3, currentTitle: 'Harden the receiver path for proxied Cordis service calls without binding methods', checking: true, childId: 'child-1' }

const failed = { planId: 'p-fixture-failed', title: 'Endeavour plan: stopped', tasks: [
  { id: 't1', title: 'Reproduce the failure', status: 'succeeded', startedAt: now - 200000, finishedAt: now - 150000 },
  { id: 't2', title: 'Apply the fix', status: 'failed', startedAt: now - 140000, finishedAt: now - 30000, note: 'Verification did not pass' },
], completedCount: 1, total: 2, checking: false, terminal: { outcome: 'failed', at: now - 30000, note: 'Verification did not pass' }, childId: 'child-1' }

const dock = (data) => (
  <PlanDock
    useChat={(selector) => selector({ nodes: { values: () => [{ key: 'n', kind: 'endeavour-plan', id: data.planId, target: 'chat', anchorSeq: 1, location: { kind: 'session' }, visibility: 'visible', data }] } })}
    t={copy}
    openSession={() => {}}
  />
)

const root = createRoot(document.getElementById('root'))
root.render(
  <div style={{ background: '#0f1115', padding: 24, display: 'grid', gap: 16, maxWidth: 900 }}>
    <div style={{ color: '#8a8f98', fontSize: 12, fontFamily: 'system-ui' }}>Composer dock surface (full width, above the composer)</div>
    {dock(active)}
    <div style={{ color: '#8a8f98', fontSize: 12, fontFamily: 'system-ui' }}>Transcript card surface</div>
    <PlanView data={active} copy={copy} onOpenBuilder={() => {}} variant="card" />
    <PlanView data={failed} copy={copy} onOpenBuilder={() => {}} variant="card" />
  </div>,
)
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
