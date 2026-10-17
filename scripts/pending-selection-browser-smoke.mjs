import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const temporaryRoot = await mkdtemp(join(tmpdir(), 'orbital-agents-lock-smoke-'))
const bundlePath = join(temporaryRoot, 'store.js')
const fixtureScript = `import { createPendingChallengerSelectionStore } from '/store.js'
const lockProvider = {
  request: (name, options, callback) => navigator.locks.request(name, { mode: 'exclusive', signal: options.signal }, () => callback()),
}
const store = createPendingChallengerSelectionStore({
  storage: window.localStorage,
  lockProvider,
  origin: location.origin,
  rootSessionId: 'browser-smoke-root',
  eventTarget: window,
})
window.pendingSelectionSmoke = {
  origin: location.origin,
  key: store.key,
  hasNativeLocks: typeof navigator.locks?.request === 'function',
  save: (model) => store.save({ provider: 'smoke-provider', model }),
  removeIfRevision: (revision) => store.removeIfRevision(revision),
  snapshot: () => store.getSnapshot(),
  dispose: () => store.dispose(),
}
window.pendingSelectionSmokeReady = true
`
const html = '<!doctype html><html><head><meta charset="utf-8"><title>Pending selection lock smoke</title></head><body><p id="ready">Pending selection lock smoke</p><script type="module" src="/fixture.js"></script></body></html>'

let server
try {
  await build({
    entryPoints: [resolve('src/client/challenger-selection-store.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outfile: bundlePath,
  })
  const storeBundle = await readFile(bundlePath)
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname
    if (request.method === 'POST' && path === '/__shutdown') {
      response.writeHead(204)
      response.end()
      response.once('finish', () => server.close())
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (path === '/store.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(storeBundle)
      return
    }
    if (path === '/fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(fixtureScript)
      return
    }
    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    response.writeHead(404).end()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('smoke server did not bind a TCP port')
  process.once('SIGINT', () => server.close())
  process.once('SIGTERM', () => server.close())
  console.log(`PENDING_SELECTION_SMOKE_URL=http://127.0.0.1:${address.port}/`)
  await new Promise((resolveClose) => server.once('close', resolveClose))
} finally {
  if (server?.listening) await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  await rm(temporaryRoot, { recursive: true, force: true })
}
