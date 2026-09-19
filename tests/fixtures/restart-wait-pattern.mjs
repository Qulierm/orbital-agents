/**
 * Hermetic fixture: the "schedule a restart, then keep waiting" pattern.
 *
 * It stands in for a foreground tool call that starts a detached restart worker
 * and then keeps the call alive with `sleep`, `tail`, `ps` and `lsof` polling.
 * The worker quits the host that OWNS this call, so the call dies mid-flight,
 * its outcome is unknown, and the report step at the end is never reached.
 *
 * Environment:
 *   FIXTURE_MODE=old  schedule, then wait/poll (the unsafe pattern)
 *   FIXTURE_MODE=safe schedule, write the report marker immediately, then exit
 *   FIXTURE_HOST     path of the stand-in host process script to spawn
 *   FIXTURE_DIR      directory for the worker log and the report marker
 *   FIXTURE_DELAY_MS how long the worker waits before quitting the host
 */

import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.FIXTURE_MODE ?? 'old'
const dir = process.env.FIXTURE_DIR ?? process.cwd()
const hostScript = process.env.FIXTURE_HOST ?? ''
const delayMs = Number(process.env.FIXTURE_DELAY_MS ?? '1500')
const logPath = join(dir, 'worker.log')
const markerPath = join(dir, 'report.json')

/** Detached worker: waits independently, then quits the host it was told to. */
const workerSource = `
  const { appendFileSync } = require('node:fs')
  const { spawnSync } = require('node:child_process')
  const log = ${JSON.stringify(logPath)}
  const record = (phase) => appendFileSync(log, JSON.stringify({ phase, at: Date.now() }) + '\\n')
  record('requested')
  setTimeout(() => {
    record('quit')
    const hostPid = Number(process.env.FIXTURE_HOST_PID ?? '0')
    try { process.kill(-hostPid, 'SIGTERM') } catch { try { process.kill(hostPid, 'SIGTERM') } catch {} }
    record('open')
    spawnSync('/bin/echo', ['opened'], { stdio: 'ignore' })
    setTimeout(() => record('ready'), 300)
  }, ${delayMs})
`
const node = process.env.DSH_TEST_NODE ?? process.execPath
const worker = spawn(node, ['-e', workerSource], { detached: true, stdio: 'ignore', env: { ...process.env } })
worker.unref()
appendFileSync(logPath, `${JSON.stringify({ phase: 'scheduled', at: Date.now() })}\n`)

if (mode === 'safe') {
  // The safe contract: report immediately, do not keep the call alive.
  writeFileSync(markerPath, `${JSON.stringify({ outcome: 'restart scheduled' })}\n`)
  process.exit(0)
}

// The unsafe pattern: keep waiting and probing in the same call.
const started = Date.now()
while (Date.now() - started < 30_000) {
  try {
    // Stand-in for the `ps`/`lsof` polling the pattern performs.
    execFileSync('/bin/ps', ['-Ao', 'pid,command'], { stdio: 'ignore' })
  } catch {
    // Polling failures are ignored by the original pattern too.
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
}
writeFileSync(markerPath, `${JSON.stringify({ outcome: 'reported after restart' })}\n`)
