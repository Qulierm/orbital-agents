/**
 * READ-ONLY scanner for historical Endeavour plans in real session storage.
 *
 * It reuses the repair tool's safe frame handling: zstd files are split into
 * RFC 8878 frames and decoded frame-by-frame (multi-frame logs included), plain
 * jsonl files are read directly, and any unreadable file is reported instead of
 * guessed at. NOTHING is ever written or rewritten.
 *
 * The scanner classifies the LATEST `endeavour/plan` checkpoint per root as:
 * - legacy: it carries only the historical `childId` (no canonical pair or
 *   `challengerSessionId`);
 * - terminal (completed/failed) vs nonterminal.
 *
 * Nonterminal legacy plans are the ones the installer must refuse to migrate.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decompressZstd, parseZstdFrames, sessionFiles } from './repair-session-events.mjs'

/** Decode one session log read-only; throws for corrupt content. */
export function decodeSessionLog(path) {
  const bytes = readFileSync(path)
  if (!path.endsWith('.zstd')) return bytes.toString('utf8')
  // `parseZstdFrames` returns the frame bytes themselves, so each frame is
  // decoded directly — the same idiom the repair tool uses. Passing a subarray
  // of nonexistent start/end fields would re-decode the whole log per frame.
  const frames = parseZstdFrames(bytes)
  let text = ''
  for (const frame of frames) text += decompressZstd(frame)
  return text
}

/** Latest plan checkpoint of every root seen in one decoded log file. */
export function latestPlans(text) {
  const latest = new Map()
  for (const line of text.split('\n')) {
    if (line === '' || !line.includes('"endeavour/plan"')) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const plan = parsed?.data?.plan
    if (plan === undefined || typeof plan.planId !== 'string' || typeof plan.rootSessionId !== 'string') continue
    const previous = latest.get(plan.rootSessionId)
    if (previous === undefined || (typeof plan.sequence === 'number' && plan.sequence >= (previous.sequence ?? -1))) {
      latest.set(plan.rootSessionId, plan)
    }
  }
  return latest
}

/** Classify a plan checkpoint: legacy vs peer, terminal vs not. */
export function classifyPlan(plan) {
  const legacy = plan.challengerSessionId === undefined && typeof plan.childId === 'string' && plan.childId !== ''
  return { legacy, terminal: plan.terminal !== undefined }
}

/**
 * Scan a sessions root read-only.
 * @returns {{ scannedFiles: number, corruptFiles: string[], terminal: object[], nonterminal: object[] }}
 */
export function scanLegacyPlans({ sessionsRoot }) {
  const report = { scannedFiles: 0, corruptFiles: [], terminal: [], nonterminal: [] }
  for (const file of sessionFiles(sessionsRoot)) {
    report.scannedFiles += 1
    let text
    try {
      text = decodeSessionLog(file)
    } catch {
      report.corruptFiles.push(file)
      continue
    }
    for (const plan of latestPlans(text).values()) {
      const { legacy, terminal } = classifyPlan(plan)
      if (!legacy) continue
      const entry = {
        file,
        planId: plan.planId,
        rootSessionId: plan.rootSessionId,
        childId: plan.childId,
        title: typeof plan.title === 'string' ? plan.title : undefined,
      }
      ;(terminal ? report.terminal : report.nonterminal).push(entry)
    }
  }
  return report
}

/** Human-readable remediation lines for nonterminal legacy plans. */
export function legacyRemediation(report) {
  return [
    ...report.nonterminal.map((plan) =>
      `- session ${plan.rootSessionId} plan ${plan.planId}${plan.title === undefined ? '' : ` ("${plan.title}")`}: finish it with the previous plugin version, or archive/cancel it explicitly`),
    ...report.corruptFiles.map((file) => `- unreadable session log ${file}: repair or archive it before migrating`),
  ]
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (invokedDirectly) {
  const homeBase = process.env.DSH_ENDEAVOUR_HOME ?? process.env.HOME ?? ''
  const sessionsRoot = join(homeBase, '.dsh', 'sessions')
  const report = existsSync(sessionsRoot) ? scanLegacyPlans({ sessionsRoot }) : { scannedFiles: 0, corruptFiles: [], terminal: [], nonterminal: [] }
  console.log(`legacy-plan-scan: ${String(report.scannedFiles)} file(s), terminal legacy ${String(report.terminal.length)}, nonterminal legacy ${String(report.nonterminal.length)}, unreadable ${String(report.corruptFiles.length)}`)
  for (const plan of report.terminal) console.log(`  terminal: ${plan.rootSessionId} / ${plan.planId}`)
  for (const line of legacyRemediation(report)) console.log(`  ${line}`)
  process.exit(report.nonterminal.length > 0 ? 1 : 0)
}
