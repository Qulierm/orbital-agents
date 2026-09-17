/** Deterministic card preview: bundle PlanCard with fixture data into one HTML file. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('tmp', { recursive: true })

const entry = `
import { createRoot } from 'react-dom/client'
import { PlanCard } from '../src/client/PlanCard.tsx'

const now = Date.now()
const t = (key) => ({ 'plan.title': 'План Endeavour', 'plan.progress': 'Выполнено {completed} из {total}',
  'plan.current': 'Текущая задача: {title}', 'plan.checking': 'Endeavour проверяет результат',
  'plan.openBuilder': 'Открыть Builder', 'plan.completed': 'План завершён', 'plan.failed': 'План остановлен' })[key] ?? key

const active = { planId: 'p-fixture-active', title: 'План Endeavour: MVP плагина', tasks: [
  { id: 't1', title: 'Скаффолд пакета', status: 'succeeded', startedAt: now - 120000, finishedAt: now - 60000 },
  { id: 't2', title: 'Durable workflow', status: 'running', startedAt: now - 55000 },
  { id: 't3', title: 'Plan card', status: 'waiting' },
], completedCount: 1, total: 3, currentTitle: 'Durable workflow', checking: true, childId: 'child-1' }

const failed = { planId: 'p-fixture-failed', title: 'План Endeavour: остановлен', tasks: [
  { id: 't1', title: 'Скаффолд пакета', status: 'succeeded', startedAt: now - 200000, finishedAt: now - 150000 },
  { id: 't2', title: 'Durable workflow', status: 'failed', startedAt: now - 140000, finishedAt: now - 30000, note: 'Проверка не прошла' },
], completedCount: 1, total: 2, checking: false, terminal: { outcome: 'failed', at: now - 30000, note: 'Проверка не прошла' }, childId: 'child-1' }

const root = createRoot(document.getElementById('root'))
root.render(<div style={{ background: '#0f1115', padding: 24, display: 'grid', gap: 16 }}>
  <PlanCard node={{ data: active }} t={t} openSession={() => {}} />
  <PlanCard node={{ data: failed }} t={t} openSession={() => {}} />
</div>)
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

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Endeavour card fixture</title></head>
<body style="margin:0;background:#0f1115"><div id="root"></div><script src="./card-preview.bundle.js"></script></body></html>`
writeFileSync('tmp/card-preview.html', html)
console.log('card-preview written to tmp/card-preview.html')
