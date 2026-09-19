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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_BUNDLE = '/Applications/DSH Desktop.app'
const DEFAULT_DELAY_SECONDS = 45
const DEFAULT_PORT = 43120
const DEFAULT_MAIN_MATCH = `${APP_BUNDLE}/Contents/MacOS/DSH Desktop`
const DEFAULT_QUIT_TIMEOUT_MS = 60_000
const DEFAULT_READY_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 1_000

/**
 * Production commands as explicit executable/argv pairs. Never a shell string:
 * splitting one on whitespace would hand `quit app "DSH Desktop"` to osascript
 * as four arguments and break the app bundle path on its space.
 */
const QUIT_EXECUTABLE = '/usr/bin/osascript'
const QUIT_ARGV = ['-e', 'quit app "DSH Desktop"']
const OPEN_EXECUTABLE = '/usr/bin/open'
const OPEN_ARGV = [APP_BUNDLE]

/**
 * Normalized scheduler configuration. Both modes parse it through the same
 * helper, so schedule mode can never print success for settings the detached
 * worker would reject before it even opens its log.
 */
function readConfig({ source, fallbackDelaySeconds }) {
  return {
    delaySeconds: numericOption('--delay-seconds', source.delaySeconds, { minimum: 0, fallback: fallbackDelaySeconds }),
    port: numericOption('DSH_RESTART_PORT', source.port, { minimum: 1, fallback: DEFAULT_PORT }),
    quitTimeoutMs: numericOption('DSH_RESTART_QUIT_TIMEOUT_MS', source.quitTimeoutMs, { minimum: 1, fallback: DEFAULT_QUIT_TIMEOUT_MS }),
    readyTimeoutMs: numericOption('DSH_RESTART_READY_TIMEOUT_MS', source.readyTimeoutMs, { minimum: 1, fallback: DEFAULT_READY_TIMEOUT_MS }),
    mainMatch: source.mainMatch ?? DEFAULT_MAIN_MATCH,
  }
}

/** Parse a CLI/env numeric value, rejecting NaN, negatives and non-integers. */
function numericOption(name, raw, { minimum, fallback }) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new Error(`schedule-desktop-restart: ${name} must be an integer >= ${String(minimum)}, got ${JSON.stringify(raw)}`)
  }
  return value
}

/** Structured, timestamped progress log; every phase is durable evidence. */
function createRecorder(logPath) {
  // Append: the scheduler already recorded the `scheduled` phase in this file.
  mkdirSync(dirname(logPath), { recursive: true })
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

/** Run one executable/argv pair without a shell. */
function runCommand(executable, argv) {
  return spawnSync(executable, [...argv], { stdio: 'ignore' }).status === 0
}

async function worker() {
  const id = flag('--id') ?? String(Date.now())
  const logPath = flag('--log') ?? join(restartRoot(), `${id}.log`)
  // The recorder exists before ANY option is parsed, so a malformed worker
  // invocation still leaves durable failure evidence instead of an empty log.
  let record
  try {
    record = createRecorder(logPath)
  } catch (error) {
    process.stderr.write(`schedule-desktop-restart: cannot open log ${logPath}: ${String(error.message)}\n`)
    return 1
  }
  let config
  try {
    config = readConfig({
      source: {
        delaySeconds: flag('--delay-seconds'),
        // The scheduler passes normalized values explicitly; the environment
        // stays a supported fallback for a hand-run worker.
        port: flag('--port') ?? process.env.DSH_RESTART_PORT,
        quitTimeoutMs: flag('--quit-timeout-ms') ?? process.env.DSH_RESTART_QUIT_TIMEOUT_MS,
        readyTimeoutMs: flag('--ready-timeout-ms') ?? process.env.DSH_RESTART_READY_TIMEOUT_MS,
        mainMatch: process.env.DSH_RESTART_MAIN_MATCH,
      },
      fallbackDelaySeconds: DEFAULT_DELAY_SECONDS,
    })
  } catch (error) {
    record('failed', { step: 'config', message: String(error.message) })
    process.stderr.write(`${String(error.message)}\n`)
    return 2
  }
  const { delaySeconds, port, mainMatch } = config
  const quitTimeout = config.quitTimeoutMs
  const readyTimeout = config.readyTimeoutMs
  // Hermetic mode: quit/open are simulated and never executed, so tests can
  // prove the protocol without touching a real desktop.
  const simulate = process.env.DSH_RESTART_TEST_MODE !== undefined
  record('worker-started', { delaySeconds, port })

  await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1_000))
  record('delay-elapsed')

  const quitExecutable = process.env.DSH_RESTART_QUIT_EXECUTABLE ?? QUIT_EXECUTABLE
  const quitArgv = process.env.DSH_RESTART_QUIT_ARGV === undefined
    ? QUIT_ARGV
    : JSON.parse(process.env.DSH_RESTART_QUIT_ARGV)
  // The durable record always carries the exact production construction, so a
  // hermetic run proves the argv without executing it.
  record('quit', { executable: quitExecutable, argv: quitArgv })
  const quitOk = simulate ? process.env.DSH_RESTART_TEST_QUIT_FAIL !== '1' : runCommand(quitExecutable, quitArgv)
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

  const openExecutable = process.env.DSH_RESTART_OPEN_EXECUTABLE ?? OPEN_EXECUTABLE
  const openArgv = process.env.DSH_RESTART_OPEN_ARGV === undefined
    ? OPEN_ARGV
    : JSON.parse(process.env.DSH_RESTART_OPEN_ARGV)
  record('open', { executable: openExecutable, argv: openArgv })
  const openOk = simulate ? process.env.DSH_RESTART_TEST_OPEN_FAIL !== '1' : runCommand(openExecutable, openArgv)
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

/** Run the worker body, recording any unexpected failure durably. */
async function workerGuarded() {
  try {
    return await worker()
  } catch (error) {
    const logPath = flag('--log')
    const message = error instanceof Error ? error.message : String(error)
    if (typeof logPath === 'string' && logPath !== '') {
      try {
        createRecorder(logPath)('failed', { step: 'worker', message })
      } catch {
        // The log itself is unusable; stderr below still reports the failure.
      }
    }
    process.stderr.write(`schedule-desktop-restart: worker failed: ${message}\n`)
    return 1
  }
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
  // EVERY inherited setting is validated here, before a log exists or a child
  // is spawned: success may only mean "configuration valid AND child spawned".
  let config
  try {
    const requested = readConfig({
      source: {
        delaySeconds: flag('--delay-seconds'),
        port: process.env.DSH_RESTART_PORT,
        quitTimeoutMs: process.env.DSH_RESTART_QUIT_TIMEOUT_MS,
        readyTimeoutMs: process.env.DSH_RESTART_READY_TIMEOUT_MS,
        mainMatch: process.env.DSH_RESTART_MAIN_MATCH,
      },
      fallbackDelaySeconds: DEFAULT_DELAY_SECONDS,
    })
    config = {
      ...requested,
      // Production floor: the report needs time to land before the worker acts.
      delaySeconds: process.env.DSH_RESTART_TEST_MODE !== undefined ? requested.delaySeconds : Math.max(requested.delaySeconds, 30),
    }
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n`)
    return 2
  }
  const root = restartRoot()
  mkdirSync(root, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const id = `${stamp}-${process.pid}`
  const logPath = join(root, `${id}.log`)
  // The schedule record is written BEFORE the spawn so it is deterministically
  // the first line, and a spawn failure is appended right after it.
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), phase: 'scheduled', detail: { delaySeconds: config.delaySeconds } })}\n`)
  const node = process.env.DSH_RESTART_NODE ?? process.execPath
  const workerProcess = spawn(node, [
    fileURLToPath(import.meta.url),
    '--worker', '--id', id, '--log', logPath,
    '--delay-seconds', String(config.delaySeconds),
    '--port', String(config.port),
    '--quit-timeout-ms', String(config.quitTimeoutMs),
    '--ready-timeout-ms', String(config.readyTimeoutMs),
  ], { detached: true, stdio: 'ignore' })
  // Await ONLY the spawn acknowledgement — never the restart itself. Success is
  // reported after the OS confirms the child, so a spawn failure cannot be
  // announced as a scheduled restart.
  const spawned = await new Promise((resolveSpawn) => {
    workerProcess.once('spawn', () => { resolveSpawn(true) })
    workerProcess.once('error', () => { resolveSpawn(false) })
  })
  if (!spawned) {
    appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), phase: 'failed', detail: { step: 'spawn', message: `cannot spawn ${node}` } })}\n`)
    process.stderr.write(`schedule-desktop-restart: could not spawn the restart worker (${node}); see ${logPath}\n`)
    return 1
  }
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), phase: 'worker-spawned', detail: { workerPid: workerProcess.pid } })}\n`)
  workerProcess.unref()
  process.stdout.write(`schedule-desktop-restart: scheduled id=${id} delay=${config.delaySeconds}s log=${logPath}\n`)
  process.stdout.write('schedule-desktop-restart: report the scheduled restart now; do not wait for it in this call\n')
  return 0
}

const code = hasFlag('--worker') ? await workerGuarded() : hasFlag('--help') ? (help(), 0) : await schedule()
process.exit(code)
