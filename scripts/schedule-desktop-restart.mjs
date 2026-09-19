#!/usr/bin/env node
/**
 * Detached DSH Desktop restart scheduler.
 *
 * Quitting DSH Desktop kills the host that owns an active Bash tool call, so a
 * call that schedules a restart and then keeps waiting can never finish its own
 * report: DSH records it as interrupted with an unknown outcome. This script
 * therefore splits the work in two.
 *
 *   schedule mode (public):
 *     validates the platform, creates the package-owned restart log directory,
 *     spawns a detached worker with stdio ignored, unrefs it and returns
 *     IMMEDIATELY with the schedule id and log path. The caller reports the
 *     scheduled restart and stops; it never waits, tails, polls or sleeps.
 *
 *   worker mode (private):
 *     waits the configured delay independently, records timestamped phases in
 *     the durable log, quits DSH Desktop with `osascript`, waits for the old
 *     main process to leave, reopens the app bundle and polls the GUI port until
 *     it answers or the bounded timeout expires.
 *
 * Usage:
 *   node scripts/schedule-desktop-restart.mjs [--delay-seconds 45]
 *   node scripts/schedule-desktop-restart.mjs --worker --id <id> --log <path> --delay-seconds 45
 *   node scripts/schedule-desktop-restart.mjs --help
 *
 * Nothing here touches settings, credentials, session data or the app bundle.
 * Test hooks (all optional, used only by the hermetic tests):
 *   DSH_RESTART_HOME      replaces the home directory used for the log root
 *   DSH_RESTART_TEST_MODE when set, quit/open/process/port are simulated
 *   DSH_RESTART_QUIT_CMD  command template for the quit step (worker mode)
 *   DSH_RESTART_OPEN_CMD  command template for the open step (worker mode)
 *   DSH_RESTART_PORT      GUI port to poll (default 43120)
 *   DSH_RESTART_MAIN_MATCH process command substring of the app main process
 *   DSH_RESTART_QUIT_TIMEOUT_MS / DSH_RESTART_READY_TIMEOUT_MS bounded waits
 */

import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP_BUNDLE = '/Applications/DSH Desktop.app'
const DEFAULT_DELAY_SECONDS = 45
const DEFAULT_PORT = 43120
const DEFAULT_MAIN_MATCH = `${APP_BUNDLE}/Contents/MacOS/DSH Desktop`
const DEFAULT_QUIT_TIMEOUT_MS = 60_000
const DEFAULT_READY_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_000

/** Structured, timestamped progress log; every phase is durable evidence. */
function createRecorder(logPath) {
  // Append: the scheduler already recorded the `scheduled` phase in this file.
  mkdirSync(join(logPath, '..'), { recursive: true })
  return (phase, detail) => {
    const entry = { at: new Date().toISOString(), pid: process.pid, phase, ...(detail === undefined ? {} : { detail }) }
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
  }
}

function restartRoot() {
  const home = process.env.DSH_RESTART_HOME ?? homedir()
  return join(home, '.dsh', 'backups', 'endeavour', 'restarts')
}

function flag(name) {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function hasFlag(name) {
  return process.argv.slice(2).includes(name)
}

/** Wait until the predicate holds or the bound expires; never polls forever. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

function portListening(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { stdio: 'ignore' })
  return result.status === 0
}

function mainProcessRunning(match) {
  const result = spawnSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf8' })
  if (result.status !== 0) return false
  return result.stdout.split('\n').some((line) => line.includes(match) && !line.includes('grep'))
}

/** Run a command template such as `osascript -e "…"` without a shell. */
function runTemplate(command) {
  const parts = command.split(' ').filter((part) => part !== '')
  const [bin, ...args] = parts
  return spawnSync(bin, args, { stdio: 'ignore' }).status === 0
}

async function worker() {
  const id = flag('--id') ?? String(Date.now())
  const logPath = flag('--log') ?? join(restartRoot(), `${id}.log`)
  const delaySeconds = Number(flag('--delay-seconds') ?? DEFAULT_DELAY_SECONDS)
  const port = Number(process.env.DSH_RESTART_PORT ?? DEFAULT_PORT)
  const mainMatch = process.env.DSH_RESTART_MAIN_MATCH ?? DEFAULT_MAIN_MATCH
  const quitTimeout = Number(process.env.DSH_RESTART_QUIT_TIMEOUT_MS ?? DEFAULT_QUIT_TIMEOUT_MS)
  const readyTimeout = Number(process.env.DSH_RESTART_READY_TIMEOUT_MS ?? DEFAULT_READY_TIMEOUT_MS)
  // Hermetic mode: quit/open are simulated and never executed, so tests can
  // prove the protocol without touching a real desktop.
  const simulate = process.env.DSH_RESTART_TEST_MODE !== undefined
  const record = createRecorder(logPath)
  record('worker-started', { delaySeconds, port })

  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000))
  record('delay-elapsed')

  const quitCommand = process.env.DSH_RESTART_QUIT_CMD ?? `/usr/bin/osascript -e quit app "DSH Desktop"`
  record('quit')
  const quitOk = simulate ? process.env.DSH_RESTART_TEST_QUIT_FAIL !== '1' : runTemplate(quitCommand)
  if (!quitOk) {
    record('failed', { step: 'quit' })
    return 1
  }
  const gone = simulate ? true : await waitFor(() => !mainProcessRunning(mainMatch), quitTimeout)
  if (!gone) {
    record('failed', { step: 'quit-wait' })
    return 1
  }
  record('quit-done')

  const openCommand = process.env.DSH_RESTART_OPEN_CMD ?? `/usr/bin/open ${APP_BUNDLE}`
  record('open')
  const openOk = simulate ? process.env.DSH_RESTART_TEST_OPEN_FAIL !== '1' : runTemplate(openCommand)
  if (!openOk) {
    record('failed', { step: 'open' })
    return 1
  }
  const ready = simulate
    ? process.env.DSH_RESTART_TEST_READY_FAIL !== '1'
    : await waitFor(() => portListening(port), readyTimeout)
  if (!ready) {
    record('failed', { step: 'ready-wait', port })
    return 1
  }
  record('ready', { port })
  return 0
}

function help() {
  process.stdout.write([
    'schedule-desktop-restart: quit and reopen DSH Desktop from a detached worker.',
    '',
    '  node scripts/schedule-desktop-restart.mjs [--delay-seconds 45]',
    '  node scripts/schedule-desktop-restart.mjs --worker --id <id> --log <path> [--delay-seconds 45]',
    '',
    'Schedule mode returns immediately with the schedule id and log path. Report the',
    'scheduled restart at once and stop: never wait for the restart in the same call.',
    '',
  ].join('\n'))
}

async function schedule() {
  const platform = process.env.DSH_RESTART_TEST_PLATFORM ?? process.platform
  if (platform !== 'darwin') {
    process.stderr.write(`schedule-desktop-restart: unsupported platform ${platform}; this helper is macOS-only\n`)
    return 2
  }
  const requestedDelay = Number(flag('--delay-seconds') ?? DEFAULT_DELAY_SECONDS)
  const delaySeconds = process.env.DSH_RESTART_TEST_MODE !== undefined
    ? Math.max(requestedDelay, 0)
    : Math.max(requestedDelay, 30)
  const root = restartRoot()
  mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${stamp}-${process.pid}`
  const logPath = join(root, `${id}.log`)
  const workerProcess = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    '--worker', '--id', id, '--log', logPath, '--delay-seconds', String(delaySeconds),
  ], { detached: true, stdio: 'ignore' })
  workerProcess.unref()
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), phase: 'scheduled', detail: { delaySeconds, workerPid: workerProcess.pid } })}\n`)
  process.stdout.write(`schedule-desktop-restart: scheduled id=${id} delay=${delaySeconds}s log=${logPath}\n`)
  process.stdout.write('schedule-desktop-restart: report the scheduled restart now; do not wait for it in this call\n')
  return 0
}

const code = hasFlag('--worker') ? await worker() : hasFlag('--help') ? (help(), 0) : await schedule()
process.exit(code)
