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
import { parseZstdFrames } from '../scripts/repair-session-events.mjs'

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

/** Whole-file decode of already-compressed bytes, for equivalence checks. */
function zstdDecode(bytes: Buffer | Uint8Array): string {
  return execFileSync('zstd', ['-dc'], { input: bytes, maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
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

/**
 * Frame-wise decoding contract: `parseZstdFrames` returns `Uint8Array` frames,
 * so the scanner must decode EACH frame directly. Feeding the whole buffer once
 * per frame still produces readable text for tiny fixtures, but on a real log
 * (hundreds of frames, megabytes each) it repeats the entire decode hundreds of
 * times and the synchronous decoder deadlocks — which is what stalled the
 * installer preflight.
 */
describe('frame-wise decoding', () => {
  const scannerSource = readFileSync(new URL('../scripts/legacy-plan-scan.mjs', import.meta.url), 'utf8')

  function multiFrameLog(): { file: string; bytes: Buffer; frames: readonly Uint8Array[] } {
    const header = '{"seq":0,"type":"session/header","data":{}}\n'
    const body = `${Array.from({ length: 40 }, (_, index) => JSON.stringify({ seq: index + 1, type: 'user/message', data: { index } })).join('\n')}\n`
    const tail = `${Array.from({ length: 10 }, (_, index) => JSON.stringify({ seq: 100 + index, type: 'user/message', data: { index } })).join('\n')}\n`
    // Three independent frames: a whole-buffer re-decode per frame would show up
    // as text repeated three times.
    const file = seedSession(tempRoot(), 'session.frames.jsonl.zstd', Buffer.concat([zstd(header), zstd(body), zstd(tail)]))
    const bytes = readFileSync(file)
    const frames = parseZstdFrames(bytes)
    return { file, bytes, frames }
  }

  it('parses frames as Uint8Array slices of the log', () => {
    const { bytes, frames } = multiFrameLog()
    expect(frames.length).toBeGreaterThanOrEqual(2)
    for (const frame of frames) expect(frame).toBeInstanceOf(Uint8Array)
    // The properties the retired loop relied on do not exist on a frame.
    expect((frames[0] as unknown as { start?: number }).start).toBeUndefined()
    expect((frames[0] as unknown as { end?: number }).end).toBeUndefined()
    expect(frames.reduce((total, frame) => total + frame.length, 0)).toBe(bytes.length)
  })

  it('decodes the log exactly once per frame and matches one whole-file decode', () => {
    const { file, bytes, frames } = multiFrameLog()
    const whole = zstdDecode(bytes)
    // Correct idiom: one direct decode per parsed frame.
    const perFrame = frames.map((frame) => zstdDecode(frame)).join('')
    expect(perFrame).toBe(whole)
    // The scanner must produce that same text, not a repeated whole decode.
    expect(decodeSessionLog(file)).toBe(whole)
  })

  it('carries no reference to the nonexistent start/end properties', () => {
    expect(scannerSource).toContain('decompressZstd(frame)')
    expect(scannerSource).not.toContain('frame.start')
    expect(scannerSource).not.toContain('frame.end')
    expect(scannerSource).not.toContain('bytes.subarray(frame')
  })

  it('documents why a whole-buffer subarray per frame is wrong', () => {
    const { bytes, frames } = multiFrameLog()
    const whole = zstdDecode(bytes)
    // The retired expression: `bytes.subarray(undefined, undefined)` is the WHOLE
    // buffer, so every frame re-decodes the entire log.
    const retired = frames
      .map((frame) => zstdDecode(bytes.subarray(
        (frame as unknown as { start?: number }).start,
        (frame as unknown as { end?: number }).end,
      )))
      .join('')
    expect(retired.length).toBe(whole.length * frames.length)
    expect(retired).not.toBe(whole)
  })
})
