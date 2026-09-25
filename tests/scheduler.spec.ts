/**
 * Detached restart scheduler contract.
 *
 * Every case runs hermetically: `DSH_RESTART_TEST_MODE` makes the worker skip
 * the real quit/open commands and the process/port probes, and
 * `DSH_RESTART_HOME` redirects the log root into a temp directory. No test here
 * quits, opens or polls the real DSH Desktop.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const SCHEDULER = join(REPO, 'scripts', 'schedule-desktop-restart.mjs')
/**
 * Real Node binary for every spawn in this spec. `process.execPath` is the DSH
 * Desktop app binary when the suite runs inside the harness, which would start
 * stray app processes instead of a plain Node.
 */
const NODE = process.env.DSH_TEST_NODE ?? execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim()
/** Environment that makes the scheduler spawn NODE for its detached worker. */
const workerNodeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env, DSH_RESTART_NODE: NODE, ...extra,
})
const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-sched-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  // The scheduler spawns its detached worker with `process.execPath`, which is
  // the DSH Desktop binary inside the harness; until the pre-spawn validation
  // lands, a red case really does start one. Kill anything still referencing
  // this test's temp home so no app process outlives the suite.
  for (const dir of dirs) killProcessesReferencing(dir)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Terminate every process whose command line mentions this path. */
function killProcessesReferencing(marker: string): void {
  const listing = spawnSync('/bin/ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' })
  if (listing.status !== 0) return
  for (const line of listing.stdout.split('\n')) {
    if (!line.includes(marker)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (!Number.isInteger(pid) || pid === process.pid) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone: nothing to clean.
    }
  }
}

function restartDir(home: string): string {
  return join(home, '.dsh', 'backups', 'endeavour', 'restarts')
}

function logs(home: string): string[] {
  const dir = restartDir(home)
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.log')).sort() : []
}

function phases(logPath: string): string[] {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { readonly phase: string }).phase)
}

/** Schedule a restart hermetically and return the parent's wall time plus logs. */
function schedule(home: string, delaySeconds = 1): { readonly ms: number; readonly stdout: string } {
  const started = Date.now()
  const result = spawnSync(NODE, [SCHEDULER, '--delay-seconds', String(delaySeconds)], {
    encoding: 'utf8',
    env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1' }),
  })
  expect(result.status).toBe(0)
  return { ms: Date.now() - started, stdout: result.stdout }
}

async function waitForPhase(logPath: string, phase: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(logPath) && phases(logPath).includes(phase)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
}

describe('detached restart scheduler', () => {
  it('refuses unsupported platforms', () => {
    const home = tempHome()
    const result = spawnSync(NODE, [SCHEDULER], {
      encoding: 'utf8',
      env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_PLATFORM: 'linux' }),
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('macOS-only')
    // Nothing was scheduled and no log root was created.
    expect(existsSync(restartDir(home))).toBe(false)
  })

  it('returns before its delay and prints the id, log path and report-now instruction', () => {
    const home = tempHome()
    const { ms, stdout } = schedule(home, 30)
    expect(ms).toBeLessThan(5_000)
    expect(stdout).toMatch(/scheduled id=\S+ delay=30s log=\S+\.log/)
    expect(stdout).toContain('report the scheduled restart now')
    expect(logs(home)).toHaveLength(1)
  })

  it('completes detached after the parent returned and records ordered evidence', async () => {
    const home = tempHome()
    schedule(home, 1)
    const logPath = join(restartDir(home), logs(home)[0]!)
    // The parent is long gone by now; the detached worker keeps going.
    expect(await waitForPhase(logPath, 'ready')).toBe(true)
    const seen = phases(logPath)
    const order = ['scheduled', 'worker-started', 'delay-elapsed', 'quit', 'quit-done', 'open', 'ready']
    for (const phase of order) expect(seen).toContain(phase)
    expect(seen.filter((phase) => order.includes(phase))).toEqual(order)
    const entries = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { readonly at: string })
    // Every entry is timestamped, so the evidence is self-describing later.
    expect(entries.every((entry) => typeof entry.at === 'string' && entry.at.length > 0)).toBe(true)
  })

  it('records failure evidence instead of a false ready', async () => {
    const home = tempHome()
    const result = spawnSync(NODE, [
      SCHEDULER, '--worker', '--id', 'manual-failure', '--log', join(home, 'failure.log'), '--delay-seconds', '1',
    ], {
      encoding: 'utf8',
      env: workerNodeEnv({ DSH_RESTART_TEST_MODE: '1', DSH_RESTART_TEST_QUIT_FAIL: '1' }),
    })
    expect(result.status).toBe(1)
    const seen = phases(join(home, 'failure.log'))
    expect(seen).toContain('failed')
    expect(seen).not.toContain('ready')
    const failed = readFileSync(join(home, 'failure.log'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { readonly phase: string; readonly detail?: { readonly step?: string } })
      .find((entry) => entry.phase === 'failed')
    expect(failed?.detail?.step).toBe('quit')
  })

  it('runs exactly one worker per schedule', async () => {
    const home = tempHome()
    schedule(home, 1)
    schedule(home, 1)
    const files = logs(home)
    expect(files).toHaveLength(2)
    for (const file of files) {
      const logPath = join(restartDir(home), file)
      expect(await waitForPhase(logPath, 'ready')).toBe(true)
      const seen = phases(logPath)
      expect(seen.filter((phase) => phase === 'scheduled')).toHaveLength(1)
      expect(seen.filter((phase) => phase === 'worker-started')).toHaveLength(1)
      expect(seen.filter((phase) => phase === 'ready')).toHaveLength(1)
    }
  })

  it('never executes the real quit or open in hermetic mode', () => {
    const source = readFileSync(SCHEDULER, 'utf8')
    // The hermetic flag short-circuits BOTH commands; the real argv is only
    // handed to spawnSync outside it, so a hermetic run executes nothing.
    expect(source).toMatch(/simulate \? process\.env\.DSH_RESTART_TEST_QUIT_FAIL !== '1' : runCommand\(quitExecutable, quitArgv\)/)
    expect(source).toMatch(/simulate \? process\.env\.DSH_RESTART_TEST_OPEN_FAIL !== '1' : runCommand\(openExecutable, openArgv\)/)
    // The schedule path must never wait.
    expect(source).not.toMatch(/^\s*(?:await\s+)?(?:sleep|execFileSync\(['"]sleep)/m)
    const scheduled = spawnSync(NODE, [SCHEDULER, '--help'], { encoding: 'utf8' })
    expect(scheduled.stdout).toContain('returns immediately')
  })

  it('is part of the published package', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { readonly files: readonly string[] }
    expect(manifest.files).toContain('scripts/schedule-desktop-restart.mjs')
    const packed = readFileSync(join(REPO, 'scripts', 'pack-check.mjs'), 'utf8')
    expect(packed).toContain('package/scripts/schedule-desktop-restart.mjs')
  })

  it('builds the production commands as exact executable/argv pairs', async () => {
    const home = tempHome()
    // Hermetic worker run: the real commands are NOT executed, but the worker
    // records exactly what it would have run.
    spawnSync(NODE, [
      SCHEDULER, '--worker', '--id', 'argv-probe', '--log', join(home, 'argv.log'), '--delay-seconds', '1',
    ], { encoding: 'utf8', env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1' }) })
    const entries = readFileSync(join(home, 'argv.log'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { readonly phase: string; readonly detail?: { readonly executable?: string; readonly argv?: readonly string[] } })
    const quit = entries.find((entry) => entry.phase === 'quit')
    const open = entries.find((entry) => entry.phase === 'open')
    // One AppleScript expression, passed as a single -e argument.
    expect(quit?.detail?.executable).toBe('/usr/bin/osascript')
    expect(quit?.detail?.argv).toEqual(['-e', 'quit app "DSH Desktop"'])
    // The app bundle is ONE argv item, spaces and all.
    expect(open?.detail?.executable).toBe('/usr/bin/open')
    expect(open?.detail?.argv).toEqual(['/Applications/DSH Desktop.app'])
  })

  it('never splits a command string on whitespace', () => {
    const source = readFileSync(SCHEDULER, 'utf8')
    expect(source).not.toMatch(/split\(' '\)/)
    expect(source).toContain("['-e', 'quit app \"DSH Desktop\"']")
    expect(source).toContain("fileURLToPath(import.meta.url)")
  })

  it('rejects invalid numeric arguments before spawning a worker', () => {
    const home = tempHome()
    for (const value of ['abc', '-5', 'NaN']) {
      const result = spawnSync(NODE, [SCHEDULER, '--delay-seconds', value], {
        encoding: 'utf8',
        env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1' }),
      })
      expect(result.status, `delay-seconds=${value}`).toBe(2)
      expect(result.stderr).toMatch(/delay-seconds/)
    }
    // Nothing was scheduled for any of the rejected values.
    expect(logs(home)).toHaveLength(0)
  })

  it('records scheduled before the worker starts', () => {
    const home = tempHome()
    schedule(home, 1)
    const logPath = join(restartDir(home), logs(home)[0]!)
    const first = JSON.parse(readFileSync(logPath, 'utf8').split('\n').filter(Boolean)[0]!) as { readonly phase: string }
    expect(first.phase).toBe('scheduled')
  })

  it('runs from an arbitrary cwd through the installed package path', () => {
    // The prompt must invoke the package where the desktop profile installed it,
    // which exists regardless of the user's working directory.
    const prompt = readFileSync(join(REPO, 'src', 'prompts', 'challenger.md'), 'utf8')
    expect(prompt).toContain('$HOME/.dsh/profiles/desktop/node_modules/dsh-orbital-agents/scripts/schedule-desktop-restart.mjs')
    const persona = readFileSync(join(REPO, 'preset', 'challenger', 'agent.cordis.yml'), 'utf8')
    expect(persona).toContain('$HOME/.dsh/profiles/desktop/node_modules/dsh-orbital-agents/scripts/schedule-desktop-restart.mjs')
    // No bare relative invocation survives anywhere the model reads.
    expect(prompt).not.toMatch(/node scripts\/schedule-desktop-restart\.mjs/)
    expect(persona).not.toMatch(/node scripts\/schedule-desktop-restart\.mjs/)
  })

  it('works when its own path contains spaces', () => {
    const home = tempHome()
    const spacedDir = join(home, 'dir with spaces')
    mkdirSync(spacedDir, { recursive: true })
    const spacedCopy = join(spacedDir, 'schedule-desktop-restart.mjs')
    copyFileSync(SCHEDULER, spacedCopy)
    const result = spawnSync(NODE, [spacedCopy, '--delay-seconds', '1'], {
      encoding: 'utf8',
      env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1' }),
    })
    expect(result.status).toBe(0)
    const logPath = join(restartDir(home), logs(home)[0]!)
    const deadline = Date.now() + 15_000
    while (!phases(logPath).includes('ready') && Date.now() < deadline) {
      spawnSync('/bin/sleep', ['0.2'])
    }
    // The worker ran from the spaced path: the URL-path bug would break it.
    expect(phases(logPath)).toContain('ready')
  })

  it('rejects every invalid inherited worker setting before creating a log', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['DSH_RESTART_PORT', 'abc'],
      ['DSH_RESTART_PORT', '-1'],
      ['DSH_RESTART_QUIT_TIMEOUT_MS', 'soon'],
      ['DSH_RESTART_QUIT_TIMEOUT_MS', '0'],
      ['DSH_RESTART_READY_TIMEOUT_MS', 'NaN'],
      ['DSH_RESTART_READY_TIMEOUT_MS', '-3'],
    ]
    for (const [name, value] of cases) {
      const home = tempHome()
      const result = spawnSync(NODE, [SCHEDULER, '--delay-seconds', '1'], {
        encoding: 'utf8',
        env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1', [name]: value }),
      })
      // RED today: schedule mode validates only --delay-seconds, so an invalid
      // inherited setting exits 0, writes a log and prints the report-now line.
      expect(result.status, `${name}=${value} exit`).toBe(2)
      expect(result.stdout, `${name}=${value} stdout`).not.toContain('report the scheduled restart now')
      expect(result.stderr, `${name}=${value} stderr`).toMatch(/must be an integer/)
      expect(logs(home), `${name}=${value} logs`).toHaveLength(0)
    }
  })

  it('never reports success when the detached worker cannot spawn', () => {
    const home = tempHome()
    // Hermetic spawn failure: the scheduler spawns DSH_RESTART_NODE, so pointing
    // it at a nonexistent binary makes ChildProcess emit `error` without any
    // real desktop involvement.
    const result = spawnSync(NODE, [SCHEDULER, '--delay-seconds', '1'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_RESTART_HOME: home,
        DSH_RESTART_TEST_MODE: '1',
        DSH_RESTART_NODE: join(home, 'nonexistent-node-binary'),
      },
    })
    expect(result.status, 'exit status').not.toBe(0)
    expect(result.stdout).not.toContain('report the scheduled restart now')
    expect(result.stderr).toMatch(/could not spawn the restart worker/)
    const logPath = join(restartDir(home), logs(home)[0]!)
    // Durable evidence: the schedule attempt, then the failure.
    expect(phases(logPath)).toEqual(['scheduled', 'failed'])
  })

  it('records a durable failure for malformed private worker configuration', () => {
    const home = tempHome()
    const logPath = join(home, 'worker-bad-config.log')
    const result = spawnSync(NODE, [
      SCHEDULER, '--worker', '--id', 'bad', '--log', logPath, '--delay-seconds', '1',
    ], {
      encoding: 'utf8',
      env: workerNodeEnv({ DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1', DSH_RESTART_PORT: 'nope' }),
    })
    expect(result.status).not.toBe(0)
    // RED today: the worker parses options before creating the recorder, so the
    // log stays empty and the failure is invisible.
    expect(existsSync(logPath), 'log exists').toBe(true)
    expect(phases(logPath)).toContain('failed')
  })

  it('returns in under five seconds after the spawn acknowledgement', () => {
    const home = tempHome()
    const started = Date.now()
    const { stdout } = schedule(home, 30)
    const elapsed = Date.now() - started
    // Success waits for the OS spawn confirmation only, never for the restart.
    expect(elapsed).toBeLessThan(5_000)
    expect(stdout).toContain('report the scheduled restart now')
    const logPath = join(restartDir(home), logs(home)[0]!)
    expect(phases(logPath)).toContain('worker-spawned')
  })

  it('documents the spawn-failure hook used by the tests', () => {
    const source = readFileSync(SCHEDULER, 'utf8')
    expect(source).toContain('DSH_RESTART_NODE')
    expect(source).toMatch(/once\('spawn'/)
    expect(source).toMatch(/once\('error'/)
  })

  it('is dependency-free and exposes no library API', () => {
    const source = readFileSync(SCHEDULER, 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((specifier) => (specifier ?? '').startsWith('node:'))).toBe(true)
    expect(source).not.toMatch(/^export\s/m)
    // Executable directly, and syntax-valid as ESM.
    execFileSync(NODE, ['--check', SCHEDULER], { stdio: 'ignore' })
  })
})
