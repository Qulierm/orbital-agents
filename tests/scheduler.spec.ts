/**
 * Detached restart scheduler contract.
 *
 * Every case runs hermetically: `DSH_RESTART_TEST_MODE` makes the worker skip
 * the real quit/open commands and the process/port probes, and
 * `DSH_RESTART_HOME` redirects the log root into a temp directory. No test here
 * quits, opens or polls the real DSH Desktop.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const SCHEDULER = join(REPO, 'scripts', 'schedule-desktop-restart.mjs')
const dirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-sched-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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
  const result = spawnSync(process.execPath, [SCHEDULER, '--delay-seconds', String(delaySeconds)], {
    encoding: 'utf8',
    env: { ...process.env, DSH_RESTART_HOME: home, DSH_RESTART_TEST_MODE: '1' },
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
    const result = spawnSync(process.execPath, [SCHEDULER], {
      encoding: 'utf8',
      env: { ...process.env, DSH_RESTART_HOME: home, DSH_RESTART_TEST_PLATFORM: 'linux' },
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
    const result = spawnSync(process.execPath, [
      SCHEDULER, '--worker', '--id', 'manual-failure', '--log', join(home, 'failure.log'), '--delay-seconds', '1',
    ], {
      encoding: 'utf8',
      env: { ...process.env, DSH_RESTART_TEST_MODE: '1', DSH_RESTART_TEST_QUIT_FAIL: '1' },
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
    // The hermetic flag replaces both commands; the real ones run only outside it.
    expect(source).toMatch(/simulate \? process\.env\.DSH_RESTART_TEST_QUIT_FAIL !== '1' : runTemplate\(quitCommand\)/)
    expect(source).toMatch(/simulate \? process\.env\.DSH_RESTART_TEST_OPEN_FAIL !== '1' : runTemplate\(openCommand\)/)
    // The schedule path must never wait.
    expect(source).not.toMatch(/^\s*(?:await\s+)?(?:sleep|execFileSync\(['"]sleep)/m)
    const scheduled = spawnSync(process.execPath, [SCHEDULER, '--help'], { encoding: 'utf8' })
    expect(scheduled.stdout).toContain('returns immediately')
  })

  it('is part of the published package', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { readonly files: readonly string[] }
    expect(manifest.files).toContain('scripts/schedule-desktop-restart.mjs')
    const packed = readFileSync(join(REPO, 'scripts', 'pack-check.mjs'), 'utf8')
    expect(packed).toContain('package/scripts/schedule-desktop-restart.mjs')
  })

  it('is dependency-free and exposes no library API', () => {
    const source = readFileSync(SCHEDULER, 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((specifier) => (specifier ?? '').startsWith('node:'))).toBe(true)
    expect(source).not.toMatch(/^export\s/m)
    // Executable directly, and syntax-valid as ESM.
    execFileSync(process.execPath, ['--check', SCHEDULER], { stdio: 'ignore' })
  })
})
