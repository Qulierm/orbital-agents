/**
 * Read-only legacy plan scanner: plain/zstd/multiframe decoding, legacy vs peer
 * classification, terminal vs nonterminal, corrupt and unknown content. The
 * scanner must never mutate anything.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyPlan, decodeSessionLog, latestPlans, scanLegacyPlans } from '../scripts/legacy-plan-scan.mjs'

const homes: string[] = []

function tempRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-scan-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function planLine(plan: Record<string, unknown>): string {
  return JSON.stringify({ seq: 1, type: 'endeavour/plan', ignorable: true, data: { kind: 'plan-created', at: 1, plan } })
}

const legacyTerminal = { planId: 'p-terminal', rootSessionId: 'root-a', childId: 'child-a', title: 'Old done', sequence: 3, terminal: { outcome: 'completed', at: 9 } }
const legacyActive = { planId: 'p-active', rootSessionId: 'root-b', childId: 'child-b', title: 'Old running', sequence: 2, tasks: [] }
const peerTerminal = { planId: 'p-peer', rootSessionId: 'root-c', challengerSessionId: 'challenger-c', pairId: 'pair-c', sequence: 2, terminal: { outcome: 'completed', at: 9 } }

function seedSession(root: string, name: string, content: string | Buffer): string {
  const dir = join(root, '.dsh', 'sessions', '--workspace--')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, content)
  return file
}

function zstd(text: string): Buffer {
  return execFileSync('zstd', ['-q', '-c'], { input: Buffer.from(text, 'utf8') })
}

describe('classification', () => {
  it('separates legacy from peer and terminal from nonterminal', () => {
    expect(classifyPlan(legacyTerminal)).toEqual({ legacy: true, terminal: true })
    expect(classifyPlan(legacyActive)).toEqual({ legacy: true, terminal: false })
    expect(classifyPlan(peerTerminal)).toEqual({ legacy: false, terminal: true })
    expect(classifyPlan({ planId: 'x', rootSessionId: 'r' })).toEqual({ legacy: false, terminal: false })
  })

  it('keeps the latest checkpoint per root and ignores unknown content', () => {
    const text = [
      planLine({ ...legacyActive, sequence: 1 }),
      planLine({ ...legacyActive, sequence: 5, terminal: { outcome: 'completed', at: 3 } }),
      planLine(peerTerminal),
      JSON.stringify({ seq: 9, type: 'other/event', data: {} }),
      'not json at all',
    ].join('\n')
    const latest = latestPlans(text)
    expect(latest.size).toBe(2)
    expect(latest.get('root-b')?.sequence).toBe(5)
  })
})

describe('storage formats', () => {
  it('scans plain jsonl, single-frame and multi-frame zstd logs', () => {
    const root = tempRoot()
    seedSession(root, 'session.plain.jsonl', `${planLine(legacyTerminal)}\n`)
    seedSession(root, 'session.single.jsonl.zstd', zstd(`${planLine(legacyActive)}\n`))
    // Multi-frame: two independent frames concatenated, one per line.
    const multi = Buffer.concat([zstd(`${planLine(peerTerminal)}\n`), zstd(`${planLine({ ...legacyTerminal, planId: 'p-multi', rootSessionId: 'root-d' })}\n`)])
    seedSession(root, 'session.multi.jsonl.zstd', multi)

    const report = scanLegacyPlans({ sessionsRoot: join(root, '.dsh', 'sessions') })
    expect(report.scannedFiles).toBe(3)
    expect(report.corruptFiles).toEqual([])
    expect(report.terminal.map((plan: { planId: string }) => plan.planId).sort()).toEqual(['p-multi', 'p-terminal'])
    expect(report.nonterminal.map((plan: { planId: string }) => plan.planId)).toEqual(['p-active'])
  })

  it('reports corrupt files instead of failing and never rewrites them', () => {
    const root = tempRoot()
    const corrupt = seedSession(root, 'session.corrupt.jsonl.zstd', Buffer.from('definitely not zstd'))
    const before = readFileSync(corrupt)
    const report = scanLegacyPlans({ sessionsRoot: join(root, '.dsh', 'sessions') })
    expect(report.scannedFiles).toBe(1)
    expect(report.corruptFiles).toHaveLength(1)
    expect(report.nonterminal).toHaveLength(0)
    expect(readFileSync(corrupt)).toEqual(before)
    expect(() => decodeSessionLog(corrupt)).toThrow()
  })
})
