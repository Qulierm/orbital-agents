/**
 * Persistence/replay regressions for the rc.2 external-event compatibility
 * gap: the stored-log validator refuses `endeavour/plan` rows without the
 * envelope `ignorable: true` marker. These tests use the real
 * `KNOWN_SESSION_EVENT_TYPES` set and the real repair tool.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlanState, PlanId, planEventPayload, TaskId, type TaskSpec } from '../src/domain.js'
import { markLine, parseZstdFrames, repairSessionEvents, singletonOwnerPid } from '../scripts/repair-session-events.mjs'
import { admitEndeavourEvents } from '../src/index.js'

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-endeavour-persist-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function spec(id: string, title: string): TaskSpec {
  return {
    id: TaskId(id),
    display: { title },
    execution: { instructions: `${title} instructions`, validation: `${title} validation` },
  }
}

function planPayload() {
  const plan = createPlanState({
    planId: PlanId('p-persist'), rootSessionId: 'root', childId: 'child', title: 'Persist plan',
    tasks: [spec('t1', 'One')], at: 10,
  })
  return planEventPayload('plan-created', undefined, plan, 10)
}

/** The exact rc.2 stored-event admission predicate from `validateStoredEvents`. */
function accepts(known: ReadonlySet<string>, envelope: { type: string; ignorable?: boolean }): boolean {
  return known.has(envelope.type) || envelope.ignorable === true
}

describe('rc.2 stored-event validation gap', () => {
  it('refuses an unmarked endeavour/plan row, admits it via the shim, and admits the marked row without the shim', () => {
    const envelope = { seq: 20, type: 'endeavour/plan', data: planPayload() }
    const knownWithout = new Set(KNOWN_SESSION_EVENT_TYPES)
    knownWithout.delete('endeavour/plan')
    // Red: the shape session.append writes today is refused after restart.
    expect(accepts(knownWithout, envelope)).toBe(false)
    // The runtime admission shim keeps replay working while the plugin is mounted.
    admitEndeavourEvents(KNOWN_SESSION_EVENT_TYPES)
    expect(KNOWN_SESSION_EVENT_TYPES.has('endeavour/plan')).toBe(true)
    expect(accepts(KNOWN_SESSION_EVENT_TYPES, envelope)).toBe(true)
    // The offline repair marker makes the same row readable without the shim.
    const marked = JSON.parse(markLine(JSON.stringify(envelope)) ?? 'null') as { ignorable?: boolean }
    expect(marked.ignorable).toBe(true)
    expect(accepts(knownWithout, { ...envelope, ignorable: true })).toBe(true)
  })

  it('only rewrites valid plan rows and is idempotent', () => {
    const line = JSON.stringify({ seq: 20, type: 'endeavour/plan', data: planPayload() })
    const marked = markLine(line)
    expect(marked).toBe(line.replace('"type":"endeavour/plan"', '"type":"endeavour/plan","ignorable":true'))
    expect(markLine(marked ?? '')).toBeNull()
    expect(markLine(JSON.stringify({ seq: 1, type: 'user/message', data: {} }))).toBeNull()
    expect(markLine('not json')).toBeNull()
    expect(markLine(JSON.stringify({ seq: 2, type: 'endeavour/plan', data: {} })))
      .toBe(JSON.stringify({ seq: 2, type: 'endeavour/plan', data: {} }).replace('"type":"endeavour/plan"', '"type":"endeavour/plan","ignorable":true'))
  })
})

function writeSessionFile(root: string, project: string, lines: string[]): string {
  const dir = join(root, project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v3.jsonl.zstd')
  const frame = (text: string) => execFileSync('zstd', ['-q', '-f', '-c'], { input: Buffer.from(text, 'utf8') })
  // Real layout: frame 1 is exactly the header line; events follow in later frames.
  const header = `${JSON.stringify({ version: 3, id: project })}\n`
  const parts = [frame(header)]
  if (lines.length > 0) parts.push(frame(`${lines.join('\n')}\n`))
  writeFileSync(file, Buffer.concat(parts))
  return file
}

function readSessionFile(file: string): string {
  return execFileSync('zstd', ['-dc', file]).toString('utf8')
}

describe('offline session repair', () => {
  it('dry-runs by default, writes only the marker, backs up, and is idempotent', () => {
    const home = tempHome()
    const sessionsRoot = join(home, 'sessions')
    const backupRoot = join(home, 'backups')
    const planLine = JSON.stringify({ seq: 20, type: 'endeavour/plan', data: planPayload() })
    const userLine = JSON.stringify({ seq: 21, type: 'user/message', data: { role: 'user' } })
    const file = writeSessionFile(sessionsRoot, '--proj--', [planLine, userLine])
    const before = readSessionFile(file)

    const dry = repairSessionEvents({ sessionsRoot, backupRoot, isRunning: () => false })
    expect(dry.totals).toMatchObject({ repairedRows: 1, repairedFiles: 1, written: false })
    expect(readSessionFile(file)).toBe(before)

    const applied = repairSessionEvents({ sessionsRoot, backupRoot, write: true, isRunning: () => false })
    expect(applied.totals.repairedRows).toBe(1)
    const after = readSessionFile(file)
    expect(after).toBe(before.replace('"type":"endeavour/plan"', '"type":"endeavour/plan","ignorable":true'))
    expect(after).toContain(userLine)
    const backupFile = join(applied.totals.backupDir!, '--proj--', 'session.v3.jsonl.zstd')
    expect(existsSync(backupFile)).toBe(true)
    expect(readSessionFile(backupFile)).toBe(before)

    const second = repairSessionEvents({ sessionsRoot, backupRoot, write: true, isRunning: () => false })
    expect(second.totals.repairedRows).toBe(0)
    expect(readSessionFile(file)).toBe(after)
  })

  it('refuses to write while Desktop is running unless forced', () => {
    const home = tempHome()
    const sessionsRoot = join(home, 'sessions')
    const backupRoot = join(home, 'backups')
    const planLine = JSON.stringify({ seq: 20, type: 'endeavour/plan', data: planPayload() })
    const file = writeSessionFile(sessionsRoot, '--proj--', [planLine])
    const before = readSessionFile(file)
    expect(() => repairSessionEvents({ sessionsRoot, backupRoot, write: true, isRunning: () => true })).toThrow(/Desktop is running/)
    expect(readSessionFile(file)).toBe(before)
    const forced = repairSessionEvents({ sessionsRoot, backupRoot, write: true, force: true, isRunning: () => true })
    expect(forced.totals.repairedRows).toBe(1)
    expect(readSessionFile(file)).toContain('"ignorable":true')
  })


  it('preserves the first-frame header contract when rewriting framed logs', () => {
    const home = tempHome()
    const sessionsRoot = join(home, 'sessions')
    const backupRoot = join(home, 'backups')
    const dir = join(sessionsRoot, '--proj--')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v3.jsonl.zstd')
    const header = `${JSON.stringify({ version: 3, id: 'session-x' })}\n`
    const body = [
      JSON.stringify({ seq: 0, type: 'turn/start', data: { turn: 1 } }),
      JSON.stringify({ seq: 20, type: 'endeavour/plan', data: planPayload() }),
      JSON.stringify({ seq: 21, type: 'user/message', data: { role: 'user' } }),
    ].join('\n') + '\n'
    const frame = (text: string) => execFileSync('zstd', ['-q', '-f', '-c'], { input: Buffer.from(text, 'utf8') })
    writeFileSync(file, Buffer.concat([frame(header), frame(body)]))

    const applied = repairSessionEvents({ sessionsRoot, backupRoot, write: true, isRunning: () => false })
    expect(applied.totals.repairedRows).toBe(1)
    const frames = parseZstdFrames(readFileSync(file))
    expect(frames.length).toBeGreaterThanOrEqual(2)
    // The reader's contract: frame 1 decodes to exactly the header line.
    const first = execFileSync('zstd', ['-dc'], { input: frames[0] }).toString('utf8')
    expect(first).toBe(header)
    expect(first.split('\n').length).toBe(2)
    // Full content keeps every row and gains only the marker.
    const total = frames.map((f) => execFileSync('zstd', ['-dc'], { input: f }).toString('utf8')).join('')
    expect(total).toContain('"ignorable":true')
    expect(total).toContain('"type":"user/message"')
    expect(total.startsWith(header)).toBe(true)
  })

  it('keeps a marked session replayable for an unmarked process (restart integration)', () => {
    const home = tempHome()
    const sessionsRoot = join(home, 'sessions')
    const backupRoot = join(home, 'backups')
    const payloads = [planPayload()]
    const lines = payloads.map((payload, index) => JSON.stringify({ seq: 20 + index, type: 'endeavour/plan', data: payload }))
    const file = writeSessionFile(sessionsRoot, '--proj--', lines)
    repairSessionEvents({ sessionsRoot, backupRoot, write: true, isRunning: () => false })
    const stored = readSessionFile(file).trim().split('\n').map((line) => JSON.parse(line) as { type: string; ignorable?: boolean; data: { plan: { tasks: { spec: { display: { title: string } } }[] } } })
    const knownWithout = new Set(KNOWN_SESSION_EVENT_TYPES)
    knownWithout.delete('endeavour/plan')
    const planEnvelopes = stored.filter((envelope) => envelope.type === 'endeavour/plan')
    expect(planEnvelopes.length).toBeGreaterThan(0)
    for (const envelope of planEnvelopes) expect(accepts(knownWithout, envelope)).toBe(true)
    expect(planEnvelopes[0]?.data.plan.tasks[0]?.spec.display.title).toBe('One')
  })
})

describe('desktop-running guard', () => {
  it('reads the owning pid from Electron single-instance lock', () => {
    const home = tempHome()
    const lock = join(home, 'SingletonLock')
    symlinkSync('Nikitas-MacBook-Air.local-40377', lock)
    expect(singletonOwnerPid(lock)).toBe(40377)
  })

  it('reports no owner for a missing, malformed or pid-less lock', () => {
    const home = tempHome()
    expect(singletonOwnerPid(join(home, 'absent'))).toBeUndefined()
    const malformed = join(home, 'malformed')
    symlinkSync('no-pid-here', malformed)
    expect(singletonOwnerPid(malformed)).toBeUndefined()
    const zero = join(home, 'zero')
    symlinkSync('host-0', zero)
    expect(singletonOwnerPid(zero)).toBeUndefined()
  })
})
