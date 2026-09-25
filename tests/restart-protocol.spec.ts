/**
 * Restart safety contract.
 *
 * A tool call that schedules a DSH Desktop quit and then keeps running cannot
 * report: the host that owns the call dies, the call is recorded as interrupted
 * with an unknown outcome, and `challenger_report` is never reached. The first
 * half of this spec reproduces that failure hermetically; the second half pins
 * the shipped contract that avoids it (scheduler, personas, documentation).
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
/**
 * Real Node binary for the fixture host. `process.execPath` is the DSH Desktop
 * app binary when the suite runs inside the harness, which would spawn stray
 * app processes instead of a plain host.
 */
const NODE = process.env.DSH_TEST_NODE ?? execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim()
const FIXTURE = join(REPO, 'tests', 'fixtures', 'restart-wait-pattern.mjs')
const SCHEDULER = join(REPO, 'scripts', 'schedule-desktop-restart.mjs')
const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-contract-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A stand-in host: the process that owns the tool call. The worker signal that
 * "quits the desktop" terminates this process group, exactly as quitting DSH
 * Desktop terminates the host running an active Bash call.
 */
function fakeHostScript(dir: string): string {
  const path = join(dir, 'fake-host.mjs')
  writeFileSync(path, [
    "import { execFileSync, spawn } from 'node:child_process'",
    '// The host owns the tool call: the call runs in the host process group, so',
    '// quitting the host (as DSH Desktop quit does) kills the active call.',
    `spawn(${JSON.stringify(NODE)}, [process.env.FIXTURE_CALL], { stdio: 'ignore', env: { ...process.env, FIXTURE_HOST_PID: String(process.pid) } })`,
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  return path
}

interface Outcome {
  /** True when the call managed to write its report marker before dying. */
  readonly marker: boolean
  /** True when the detached worker outlived the host and finished its phases. */
  readonly workerSurvived: boolean
}

async function runCall(dir: string, mode: 'old' | 'safe'): Promise<Outcome> {
  const host = fakeHostScript(dir)
  const hostProcess = spawn(NODE, [host], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      FIXTURE_CALL: FIXTURE,
      FIXTURE_MODE: mode,
      FIXTURE_DIR: dir,
      FIXTURE_DELAY_MS: '600',
    },
  })
  hostProcess.unref()
  // The worker quits the host after the delay; wait until it is gone, then give
  // the detached worker a moment to finish its own phases.
  await new Promise<void>((resolveGone) => {
    const deadline = Date.now() + 6_000
    const poll = setInterval(() => {
      let alive = true
      try {
        process.kill(hostProcess.pid!, 0)
      } catch {
        alive = false
      }
      if (!alive || Date.now() > deadline) {
        clearInterval(poll)
        resolveGone()
      }
    }, 50)
  })
  await new Promise<void>((resolveSettled) => setTimeout(resolveSettled, 1_200))
  const log = existsSync(join(dir, 'worker.log')) ? readFileSync(join(dir, 'worker.log'), 'utf8') : ''
  return {
    marker: existsSync(join(dir, 'report.json')),
    workerSurvived: log.includes('"phase":"ready"'),
  }
}

describe('restart safety contract', () => {
  it('shows that schedule-then-wait loses the report when the host dies', async () => {
    const dir = tempDir()
    const outcome = await runCall(dir, 'old')
    // The call cannot reach its own report step: the host that owned it is gone.
    expect(outcome.marker).toBe(false)
    // Durable evidence still exists on disk, written by the detached worker,
    // which itself survived the host it killed.
    const log = readFileSync(join(dir, 'worker.log'), 'utf8')
    expect(log).toContain('"phase":"scheduled"')
    expect(log).toContain('"phase":"requested"')
    expect(log).toContain('"phase":"quit"')
    expect(outcome.workerSurvived, `worker log:\n${log}`).toBe(true)
  })

  it('shows that reporting before the restart keeps the report durable', async () => {
    const dir = tempDir()
    const outcome = await runCall(dir, 'safe')
    expect(outcome.marker).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))).toEqual({ outcome: 'restart scheduled' })
  })

  it('ships a detached restart scheduler', () => {
    expect(existsSync(SCHEDULER), 'scripts/schedule-desktop-restart.mjs must exist').toBe(true)
    const source = readFileSync(SCHEDULER, 'utf8')
    // Schedule mode must return immediately: no sleep, tail, ps or lsof polling.
    expect(source).not.toMatch(/sleep\s+\d/)
    expect(source).toContain('detached: true')
    expect(source).toContain('unref()')
    // macOS only, and explicit about refusing other platforms.
    expect(source).toContain('darwin')
    // Private worker mode with structured, timestamped evidence.
    for (const phase of ['requested', 'quit', 'open', 'ready', 'failed']) {
      expect(source, `worker must record the ${phase} phase`).toContain(phase)
    }
  })

  it('forbids the wait-after-schedule pattern in the Challenger persona', () => {
    const raw = readFileSync(join(REPO, 'preset', 'challenger', 'agent.cordis.yml'), 'utf8')
    const persona = raw.replace(/\s+/g, ' ')
    expect(persona).toContain('$HOME/.dsh/profiles/desktop/node_modules/dsh-orbital-agents/scripts/schedule-desktop-restart.mjs')
    expect(persona).toMatch(/never sleep, tail, poll processes or check ports/i)
    expect(persona).toMatch(/restart scheduled/i)
    expect(persona).toMatch(/final task/i)
    expect(persona).toMatch(/blocker/i)
  })

  it('makes the Endeavour persona place a restart last', () => {
    const raw = readFileSync(join(REPO, 'preset', 'endeavour', 'agent.cordis.yml'), 'utf8')
    const persona = raw.replace(/\s+/g, ' ')
    expect(persona).toMatch(/restart/i)
    expect(persona).toMatch(/final (builder )?task/i)
  })

  it('pins the exact Challenger sequence and the untouched tool roster', () => {
    const persona = readFileSync(join(REPO, 'preset', 'challenger', 'agent.cordis.yml'), 'utf8').replace(/\s+/g, ' ')
    // Final-task-only.
    expect(persona).toMatch(/A Desktop restart is a FINAL task only/i)
    expect(persona).toMatch(/report a blocker so the remaining tasks are not stranded/i)
    // Immediate report with honest wording, then stop.
    expect(persona).toMatch(/Immediately after that call returns, call `challenger_report` saying `restart scheduled`/i)
    expect(persona).toMatch(/then stop\. Never claim the app came back/i)
    // Interrupted legacy attempts are verified read-only before any retry.
    expect(persona).toMatch(/interrupted with an unknown outcome/i)
    expect(persona).toMatch(/inspect external state read-only first/i)
    expect(persona).toMatch(/port 43120/)
    // The packaged reference prompt carries the same contract.
    const packaged = readFileSync(join(REPO, 'src', 'prompts', 'challenger.md'), 'utf8').replace(/\s+/g, ' ')
    expect(packaged).toMatch(/A Desktop restart is a FINAL task only/i)
    expect(packaged).toMatch(/call `challenger_report` saying `restart scheduled`/i)
    // The tool roster is unchanged: exactly the two protocol tools, no delegation.
    expect(persona).toContain('`challenger_start_task`')
    expect(persona).toContain('`challenger_report`')
    expect(persona).not.toContain('builder_report')
    // The scoped row still mounts exactly the two protocol tools for this role.
    expect(persona).toMatch(/name: 'dsh-orbital-agents\/tools' config: role: challenger/)
  })

  it('documents the manual-versus-scheduled restart distinction', () => {
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    const install = readFileSync(join(REPO, 'docs', 'install.md'), 'utf8')
    expect(readme).toContain('$HOME/.dsh/profiles/desktop/node_modules/dsh-orbital-agents/scripts/schedule-desktop-restart.mjs')
    expect(install).toMatch(/schedule-desktop-restart|restart scheduled/i)
  })
})
