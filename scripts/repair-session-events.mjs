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
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

/** Event type this repair owns. */
export const EVENT_TYPE = 'endeavour/plan'
/** Every informational type this repair marks (plan + persistent peer pairs). */
export const EVENT_TYPES = ['endeavour/plan', 'endeavour/peer']
/** Exact text inserted after the type field. */
export const MARKER_TEXT = ',"ignorable":true'

/** Electron's single-instance lock; its link target names the owning host and pid. */
export const SINGLETON_LOCK_PATH = join(homedir(), 'Library', 'Application Support', 'DSH Desktop', 'SingletonLock')

/**
 * Read the live owner pid from the app's single-instance lock.
 *
 * Electron points the lock at `<hostname>-<pid>` while it runs and removes it on
 * a clean exit, so the pid is the authoritative answer; liveness is checked
 * separately because a crash leaves the link behind.
 * @param lockPath - lock link to read; defaults to the installed app's lock.
 * @returns the owner pid, or undefined when no lock names a positive one.
 */
export function singletonOwnerPid(lockPath = SINGLETON_LOCK_PATH) {
  try {
    const target = readlinkSync(lockPath)
    const pid = Number(target.slice(target.lastIndexOf('-') + 1))
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    // No lock (never started or cleanly exited) or an unreadable link: no owner.
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH means the recorded owner is gone; EPERM would still mean it exists
    // under another account, which cannot happen for this per-user app.
    return false
  }
}

/**
 * Whether DSH Desktop is currently running.
 *
 * macOS `pgrep -f` does not match the app's main process — its kernel command
 * name is truncated and its argument list is unreported — so matching the
 * executable path alone reports a running app as stopped, which would let a
 * write-mode repair rewrite live session logs. The Helper processes exist only
 * while it runs, and the single-instance lock names the live owner, so either
 * signal is enough.
 * @returns true when any of the two independent signals reports the app.
 */
export function desktopRunning() {
  if (process.env.DSH_ENDEAVOUR_TEST_NO_DESKTOP === '1') return false
  const helpers = spawnSync('pgrep', ['-f', 'DSH Desktop Helper'], { encoding: 'utf8' })
  if (helpers.status === 0 && (helpers.stdout ?? '').trim() !== '') return true
  const owner = singletonOwnerPid()
  return owner !== undefined && pidAlive(owner)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Split a zstd byte stream into frames (RFC 8878 framing), so rewrites keep
 * the reader's first-frame contract: frame 1 must decode to exactly the header
 * line.
 */
export function parseZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (!buffer.subarray(offset, offset + 4).equals(ZSTD_MAGIC)) {
      throw new Error(`repair-session-events: byte ${String(offset)} is not a zstd frame magic`)
    }
    offset += 4
    const descriptor = buffer[offset]
    offset += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const didFlag = descriptor & 0x03
    if (!singleSegment) offset += 1 // window descriptor
    offset += [0, 1, 2, 4][didFlag]
    if (fcsFlag === 0) offset += singleSegment ? 1 : 0
    else offset += [0, 2, 4, 8][fcsFlag]
    for (;;) {
      const header = buffer.readUIntLE(offset, 3)
      offset += 3
      const last = (header & 1) === 1
      const type = (header >> 1) & 0x03
      const size = header >> 3
      if (type === 0) offset += size
      else if (type === 1) offset += 1
      else if (type === 2) offset += size
      else throw new Error('repair-session-events: reserved zstd block type')
      if (last) break
    }
    if (checksum) offset += 4
    frames.push(buffer.subarray(start, offset))
  }
  return frames
}

export function decompressZstd(buffer) {
  return execFileSync('zstd', ['-dc'], { input: buffer, maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
}

function compressZstd(text) {
  return execFileSync('zstd', ['-q', '-f', '-c'], { input: Buffer.from(text, 'utf8'), maxBuffer: 256 * 1024 * 1024 })
}

/** Insert the marker into one line, or return null when nothing applies. */
export function markLine(line) {
  if (!EVENT_TYPES.some((type) => line.includes(`"type":"${type}"`))) return null
  if (line.includes('"ignorable":true')) return null
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!EVENT_TYPES.includes(parsed?.type)) return null
  const marker = `"type":"${parsed.type}"`
  const at = line.indexOf(marker)
  if (at < 0) return null
  const updated = `${line.slice(0, at + marker.length)}${MARKER_TEXT}${line.slice(at + marker.length)}`
  let after
  try {
    after = JSON.parse(updated)
  } catch {
    return null
  }
  if (after?.ignorable !== true || after?.seq !== parsed.seq || !EVENT_TYPES.includes(after?.type)) return null
  if (JSON.stringify(after.data) !== JSON.stringify(parsed.data)) return null
  return updated
}

export function sessionFiles(sessionsRoot) {
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
  const originalBytes = readFileSync(path)
  let headerText = null
  let originalText
  let headerFrame = null
  if (compressed) {
    const frames = parseZstdFrames(originalBytes)
    headerFrame = frames[0]
    headerText = decompressZstd(headerFrame)
    if (!headerText.endsWith('\n') || headerText.split('\n').length !== 2) {
      throw new Error('repair-session-events: refusing a file whose first frame is not exactly one header line')
    }
    originalText = frames.map((frame) => decompressZstd(frame)).join('')
  } else {
    originalText = originalBytes.toString('utf8')
  }
  const lines = originalText.split('\n')
  let changed = 0
  const updatedLines = lines.map((line) => {
    const next = markLine(line)
    if (next === null) return line
    changed += 1
    return next
  })
  if (changed === 0) return { file: path, changed: 0 }
  if (!write) return { file: path, changed, written: false }
  const expectedText = updatedLines.join('\n')

  // Preserve frame 1 byte-for-byte (the header line) and re-encode the
  // remainder as one frame; only the first-frame contract is load-bearing.
  let nextBytes
  if (headerFrame === null) {
    nextBytes = Buffer.from(expectedText, 'utf8')
  } else {
    const remainder = expectedText.slice(headerText.length)
    nextBytes = Buffer.concat([headerFrame, compressZstd(remainder)])
  }

  if (compressed) {
    const checkFrames = parseZstdFrames(nextBytes)
    const decoded = checkFrames.map((frame) => decompressZstd(frame)).join('')
    if (decoded !== expectedText) throw new Error('repair-session-events: rewrite failed full-decode validation')
    const firstFrameText = decompressZstd(checkFrames[0])
    if (!firstFrameText.endsWith('\n') || firstFrameText.split('\n').length !== 2) {
      throw new Error('repair-session-events: rewrite would break the first-frame header contract')
    }
  }

  const relativePath = relative(sessionsRoot, path)
  const backupPath = join(backupDir, relativePath)
  mkdirSync(join(backupPath, '..'), { recursive: true })
  copyFileSync(path, backupPath, 1) // COPYFILE_EXCL: never overwrite a backup
  const tempPath = `${path}.repair-tmp-${String(process.pid)}`
  writeFileSync(tempPath, nextBytes)
  const fd = openSync(tempPath, 'r+')
  fsyncSync(fd)
  closeSync(fd)
  try {
    renameSync(tempPath, path)
  } catch (error) {
    copyFileSync(backupPath, path) // restore on any failure after the backup
    throw error
  }
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
  // Per-file isolation: one unreadable/corrupt log must not abort the repair of
  // every other session log. Skipped files are reported and left byte-exact.
  const results = []
  const skipped = []
  for (const file of sessionFiles(sessionsRoot)) {
    try {
      results.push(processFile(file, { write, backupDir, sessionsRoot }))
    } catch (error) {
      skipped.push({ file, error: String(error?.message ?? error) })
    }
  }
  const totals = {
    files: results.length + skipped.length,
    repairedFiles: results.filter((r) => r.changed > 0).length,
    repairedRows: results.reduce((sum, r) => sum + r.changed, 0),
    written: write,
    backupDir: results.some((r) => r.changed > 0) ? backupDir : null,
    skippedFiles: skipped.length,
  }
  return { results, skipped, totals }
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
