#!/usr/bin/env node
/**
 * Safe offline repair for `endeavour/plan` session events.
 *
 * rc.2's `session.append` cannot write the envelope `ignorable: true` marker
 * that the stored-log validator requires for unknown informational types. This
 * tool adds exactly that marker to valid `endeavour/plan` rows so sessions stay
 * readable without the plugin's runtime admission shim.
 *
 * Invariants:
 * - Desktop must be stopped (override with --force).
 * - Every edited line is JSON-validated before and after; the only accepted
 *   difference is the inserted `,"ignorable":true` immediately after the type.
 * - The original file is copied to an exclusive, timestamped backup first.
 * - The rewrite is temp-file + fsync + atomic rename; zstd frames are decoded
 *   and re-encoded whole (no frame concatenation).
 * - Idempotent: a second run finds no missing markers.
 * - Never deletes or rewrites unrelated rows; dry-run by default.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, relative } from 'node:path'

/** Event type this repair owns. */
export const EVENT_TYPE = 'endeavour/plan'
/** Exact text inserted after the type field. */
export const MARKER_TEXT = ',"ignorable":true'

/** Whether DSH Desktop is currently running. */
export function desktopRunning() {
  if (process.env.DSH_ENDEAVOUR_TEST_NO_DESKTOP === '1') return false
  const result = spawnSync('pgrep', ['-f', '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop'], { encoding: 'utf8' })
  return result.status === 0 && (result.stdout ?? '').trim() !== ''
}

function decodeZstd(path) {
  return execFileSync('zstd', ['-dc', path], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
}

function encodeZstd(text, outPath) {
  execFileSync('zstd', ['-q', '-f', '-o', outPath], { input: Buffer.from(text, 'utf8') })
}

/** Insert the marker into one line, or return null when nothing applies. */
export function markLine(line) {
  if (!line.includes(`"type":"${EVENT_TYPE}"`)) return null
  if (line.includes('"ignorable":true')) return null
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (parsed?.type !== EVENT_TYPE) return null
  const marker = `"type":"${EVENT_TYPE}"`
  const at = line.indexOf(marker)
  if (at < 0) return null
  const updated = `${line.slice(0, at + marker.length)}${MARKER_TEXT}${line.slice(at + marker.length)}`
  let after
  try {
    after = JSON.parse(updated)
  } catch {
    return null
  }
  if (after?.ignorable !== true || after?.seq !== parsed.seq || after?.type !== EVENT_TYPE) return null
  if (JSON.stringify(after.data) !== JSON.stringify(parsed.data)) return null
  return updated
}

function sessionFiles(sessionsRoot) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const candidate = join(dir, name)
      let isDir = false
      try { isDir = statSync(candidate).isDirectory() } catch { isDir = false }
      if (isDir) {
        walk(candidate, depth + 1)
      } else if (name.startsWith('session.') && (name.endsWith('.jsonl.zstd') || name.endsWith('.jsonl'))) {
        found.push(candidate)
      }
    }
  }
  walk(sessionsRoot, 0)
  return found
}

function processFile(path, { write, backupDir, sessionsRoot }) {
  const compressed = path.endsWith('.zstd')
  const text = compressed ? decodeZstd(path) : readFileSync(path, 'utf8')
  const lines = text.split('\n')
  let changed = 0
  const updated = lines.map((line) => {
    const next = markLine(line)
    if (next === null) return line
    changed += 1
    return next
  })
  if (changed === 0) return { file: path, changed: 0 }
  if (!write) return { file: path, changed, written: false }
  const relativePath = relative(sessionsRoot, path)
  const backupPath = join(backupDir, relativePath)
  mkdirSync(join(backupPath, '..'), { recursive: true })
  copyFileSync(path, backupPath, 1) // COPYFILE_EXCL: never overwrite a backup
  const nextText = updated.join('\n')
  const tempPath = `${path}.repair-tmp-${String(process.pid)}`
  if (compressed) encodeZstd(nextText, tempPath)
  else writeFileSync(tempPath, nextText)
  const fd = openSync(tempPath, 'r+')
  fsyncSync(fd)
  closeSync(fd)
  renameSync(tempPath, path)
  return { file: path, changed, written: true, backupPath }
}

/**
 * Repair every session file below `sessionsRoot`.
 * @returns per-file results plus totals.
 */
export function repairSessionEvents(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? join(process.env.HOME ?? '', '.dsh', 'sessions')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = options.backupRoot ?? join(process.env.HOME ?? '', '.dsh', 'backups', 'endeavour', 'session-repair')
  const backupDir = options.backupDir ?? join(backupRoot, stamp)
  const write = options.write === true
  const force = options.force === true
  const isRunning = options.isRunning ?? desktopRunning
  if (write && !force && isRunning()) {
    throw new Error('repair-session-events: DSH Desktop is running; quit it before --write (or pass --force)')
  }
  const results = sessionFiles(sessionsRoot).map((file) => processFile(file, { write, backupDir, sessionsRoot }))
  const totals = {
    files: results.length,
    repairedFiles: results.filter((r) => r.changed > 0).length,
    repairedRows: results.reduce((sum, r) => sum + r.changed, 0),
    written: write,
    backupDir: results.some((r) => r.changed > 0) ? backupDir : null,
  }
  return { results, totals }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (invokedDirectly) {
  const write = process.argv.includes('--write')
  const force = process.argv.includes('--force')
  try {
    const { totals } = repairSessionEvents({ write, force })
    const mode = write ? 'write' : 'dry-run'
    console.log(`repair-session-events: ${mode} — ${String(totals.repairedRows)} row(s) in ${String(totals.repairedFiles)} of ${String(totals.files)} session file(s) need the ignorable marker`)
    if (write && totals.backupDir !== null) console.log(`repair-session-events: backups at ${totals.backupDir}`)
    if (!write && totals.repairedRows > 0) console.log('repair-session-events: re-run with --write to apply (Desktop must be stopped)')
  } catch (error) {
    console.error(String(error.message ?? error))
    process.exitCode = 1
  }
}

export { unlinkSync }
