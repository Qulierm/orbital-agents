#!/usr/bin/env node
/**
 * Safe local installer, preset lifecycle, and Builder-route helper for
 * dsh-endeavour.
 *
 * Usage:
 *   node scripts/install-local.mjs --tarball <path> [--profile desktop] [--force]
 *   node scripts/install-local.mjs --uninstall
 *   node scripts/install-local.mjs --rollback <timestamp>
 *   node scripts/install-local.mjs --configure-builder --provider <p> --model <m>
 *        [--reasoning-effort <e>] [--max-tokens <n>]
 *   node scripts/install-local.mjs --show-builder
 *   node scripts/install-local.mjs --reset-builder
 *   node scripts/install-local.mjs --list-backups
 *
 * Guarantees: no sudo, no app-bundle edits, backed-up mutations, atomic preset
 * install, ownership marker so uninstall never deletes a user-authored preset,
 * idempotent re-install, rollback restores profile files and preset state.
 */

import { execFileSync } from 'node:child_process'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { load, dump } from 'js-yaml'
import { desktopRunning, repairSessionEvents } from './repair-session-events.mjs'
import { legacyRemediation, scanLegacyPlans } from './legacy-plan-scan.mjs'

const PLUGIN = 'dsh-endeavour'
const PRESET_ID = 'endeavour'
/**
 * Owned preset roster. Endeavour mounts the orchestration tools plugin (so it
 * needs the package link); Challenger is a plain coding preset with its own
 * persona and no delegation rows, so it never links the plugin.
 */
const OWNED_PRESETS = [
  { id: 'endeavour', linkPackage: true },
  { id: 'challenger', linkPackage: true },
]
const OWNERSHIP_MARKER = '.dsh-endeavour-owned'
const args = process.argv.slice(2)

function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const profileName = flag('--profile') ?? 'desktop'
const homeBase = process.env.DSH_ENDEAVOUR_HOME ?? homedir()
const profileDir = join(homeBase, '.dsh', 'profiles', profileName)
const presetRoot = join(homeBase, '.dsh', '.agent-presets')
/** Directory of one owned preset (kept for the legacy single-preset helpers). */
function presetDirOf(entry) {
  return join(presetRoot, entry.id)
}
const presetDir = presetDirOf(OWNED_PRESETS[0])
const backupRoot = join(homeBase, '.dsh', 'backups', 'endeavour')
const packageRoot = resolve(import.meta.dirname, '..')

/** Repair targets derived from the same home base as the profile state. */
function repairPaths() {
  return {
    write: true,
    sessionsRoot: join(homeBase, '.dsh', 'sessions'),
    backupRoot: join(homeBase, '.dsh', 'backups', 'endeavour', 'session-repair'),
  }
}

function run(command, commandArgs, cwd) {
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit' })
}

/** Run pnpm in the profile; tests stub this to keep lifecycle checks hermetic. */
function runPnpm(commandArgs, cwd) {
  if (process.env.DSH_ENDEAVOUR_TEST_PNPM === '1') {
    console.log(`install-local(test): pnpm ${commandArgs.join(' ')} (${cwd})`)
    return
  }
  run('pnpm', commandArgs, cwd)
}

function readManifest() {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

function writeManifest(manifest) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Copy a directory to a fresh atomic location then swap it in. */
function atomicReplaceDir(source, target) {
  const staging = `${target}.staging-${timestamp()}`
  cpSync(source, staging, { recursive: true })
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
}

/**
 * Remove the RETIRED `endeavour-builder` settings namespace from the user
 * settings document (the peer model control owns the Challenger session's
 * selection now). The document is backed up first and ONLY that top-level
 * block is removed, so unrelated settings survive untouched.
 */
/**
 * Refuse to migrate while a NONTERMINAL legacy (childId-only) plan exists. The
 * scan is strictly read-only and runs BEFORE any backup, tarball, preset or
 * settings mutation, so an abort leaves the profile untouched. Terminal legacy
 * plans are allowed (they stay readable as history), and unreadable logs are
 * reported without blocking.
 */
function preflightLegacyPlans() {
  const sessionsRoot = join(homeBase, '.dsh', 'sessions')
  if (!existsSync(sessionsRoot)) return
  const report = scanLegacyPlans({ sessionsRoot })
  if (report.terminal.length > 0) {
    console.log(`install-local: ${String(report.terminal.length)} terminal legacy plan(s) remain readable as history`)
  }
  if (report.corruptFiles.length > 0) {
    console.log(`install-local: ${String(report.corruptFiles.length)} unreadable session log(s) were skipped by the legacy scan`)
  }
  if (report.nonterminal.length > 0) {
    throw new Error(
      `refusing to migrate ${String(report.nonterminal.length)} nonterminal legacy plan(s):\n${legacyRemediation(report).join('\n')}`,
    )
  }
}

function migrateOwnedSettings() {
  const settingsPath = join(homeBase, '.dsh', 'settings.yaml')
  if (!existsSync(settingsPath)) return
  const text = readFileSync(settingsPath, 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^endeavour-builder:\s*$/.test(line))
  if (start === -1) return
  let end = start + 1
  while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end += 1
  const backupDir = join(backupRoot, `settings-${timestamp()}`)
  mkdirSync(backupDir, { recursive: true })
  cpSync(settingsPath, join(backupDir, 'settings.yaml'))
  lines.splice(start, end - start)
  writeFileSync(settingsPath, lines.join('\n'))
  console.log(`install-local: removed the retired endeavour-builder settings namespace (backup at ${backupDir})`)
}

function presetOwnedByUs(entry = OWNED_PRESETS[0]) {
  return existsSync(join(presetDirOf(entry), OWNERSHIP_MARKER))
}

/**
 * Abort before ANY mutation when a preset directory exists but is not owned by
 * this plugin. Preflighting the whole roster keeps a foreign Challenger (or
 * Endeavour) conflict from leaving a partial install behind.
 */
function preflightPresets({ force }) {
  for (const entry of OWNED_PRESETS) {
    const source = join(packageRoot, 'preset', entry.id)
    const dir = presetDirOf(entry)
    if (!existsSync(source)) throw new Error(`preset asset missing: ${source}`)
    if (existsSync(dir) && !presetOwnedByUs(entry) && !force) {
      throw new Error(`refusing to overwrite existing user preset at ${dir}; re-run with --force to replace it (a backup is taken)`)
    }
  }
}

function installPreset(entry, { force }) {
  const source = join(packageRoot, 'preset', entry.id)
  const dir = presetDirOf(entry)
  if (!existsSync(source)) throw new Error(`preset asset missing: ${source}`)
  if (existsSync(dir) && !presetOwnedByUs(entry) && !force) {
    throw new Error(`refusing to overwrite existing user preset at ${dir}; re-run with --force to replace it (a backup is taken)`)
  }
  mkdirSync(presetRoot, { recursive: true })
  atomicReplaceDir(source, dir)
  writeFileSync(join(dir, OWNERSHIP_MARKER), `${PLUGIN}\n`)
  if (entry.linkPackage === true) {
    const linkPath = join(dir, 'node_modules')
    mkdirSync(linkPath, { recursive: true })
    const packageLink = join(linkPath, PLUGIN)
    rmSync(packageLink, { force: true })
    const installedPackage = join(profileDir, 'node_modules', PLUGIN)
    if (!existsSync(installedPackage)) throw new Error(`installed package missing: ${installedPackage}`)
    symlinkSync(installedPackage, packageLink, 'dir')
  }
  console.log(`install-local: preset installed at ${dir}`)
}

function installPresets(options) {
  for (const entry of OWNED_PRESETS) installPreset(entry, options)
}

function removePreset(entry = OWNED_PRESETS[0]) {
  const dir = presetDirOf(entry)
  if (!existsSync(dir)) return false
  if (!presetOwnedByUs(entry)) {
    console.log(`install-local: preset at ${dir} is not owned by ${PLUGIN}; leaving it untouched`)
    return false
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(`install-local: removed owned preset ${dir}`)
  return true
}

function backup() {
  const stamp = timestamp()
  const target = join(backupRoot, stamp)
  mkdirSync(join(target, 'profile'), { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
    const source = join(profileDir, file)
    if (existsSync(source)) cpSync(source, join(target, 'profile', file))
  }
  const presets = {}
  for (const entry of OWNED_PRESETS) {
    const dir = presetDirOf(entry)
    const existed = existsSync(dir)
    const owned = existed && presetOwnedByUs(entry)
    if (existed) cpSync(dir, join(target, `preset-${entry.id}`), { recursive: true, dereference: false })
    presets[entry.id] = { dir, existed, owned }
  }
  const legacy = presets[PRESET_ID]
  const state = {
    stamp,
    profileDir,
    presetDir: legacy.dir,
    presetExisted: legacy.existed,
    presetOwnedByUs: legacy.owned,
    presets,
    installedAt: new Date().toISOString(),
  }
  writeFileSync(join(target, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
  console.log(`install-local: backup written to ${target}`)
  return stamp
}

function latestBackup() {
  if (!existsSync(backupRoot)) return undefined
  const stamps = readdirSync(backupRoot).filter((name) => existsSync(join(backupRoot, name, 'state.json'))).sort()
  return stamps.at(-1)
}

function install(tarball, { force }) {
  // Strictly read-only gate, FIRST: no mutation happens before it passes.
  preflightLegacyPlans()
  if (!existsSync(profileDir)) throw new Error(`profile not found: ${profileDir}`)
  if (!tarball || !existsSync(resolve(tarball))) throw new Error(`tarball not found: ${String(tarball)}`)
  // Fail before any mutation (including the package install) on foreign presets.
  preflightPresets({ force })
  const stamp = backup()
  migrateOwnedSettings()
  try {
    // A file: dependency at an unchanged version is reused from the store, which
    // would leave older builds in place; remove first so the tarball is re-copied.
    try {
      runPnpm(['remove', PLUGIN], profileDir)
    } catch {
      console.log('install-local: no previous install to remove')
    }
    runPnpm(['add', resolve(tarball)], profileDir)
    const manifest = readManifest()
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) throw new Error('profile manifest has no dsh.profile.bundles array')
    if (!bundles.includes(PLUGIN)) {
      bundles.push(PLUGIN)
      writeManifest(manifest)
      console.log(`install-local: added ${PLUGIN} to dsh.profile.bundles (order preserved)`)
    }
    installPresets({ force })
  } catch (error) {
    console.error(`install-local: install failed (${String(error.message)}); rolling back to ${stamp}`)
    rollback(stamp)
    throw error
  }
  try {
    const { totals } = repairSessionEvents(repairPaths())
    console.log(`install-local: session events repaired (${String(totals.repairedRows)} row(s) in ${String(totals.repairedFiles)} file(s))`)
  } catch (error) {
    console.log(`install-local: session repair skipped (${String(error.message ?? error)})`)
  }
  console.log(`install-local: installed ${PLUGIN}; restart DSH Desktop if it is running`)
  console.log(`install-local: rollback with --rollback ${stamp}`)
}

function uninstall() {
  if (desktopRunning()) {
    throw new Error('uninstall: quit DSH Desktop first so stored sessions are repaired before the compatibility shim is removed')
  }
  repairSessionEvents(repairPaths())
  const stamp = backup()
  const manifest = readManifest()
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PLUGIN)
    writeManifest(manifest)
  }
  const state = JSON.parse(readFileSync(join(backupRoot, stamp, 'state.json'), 'utf8'))
  const presets = state.presets ?? {
    [PRESET_ID]: { dir: presetDir, existed: state.presetExisted, owned: state.presetOwnedByUs },
  }
  for (const entry of OWNED_PRESETS) {
    const prior = presets[entry.id]
    if (prior === undefined) continue
    if (prior.existed && prior.owned === false) {
      console.log(`install-local: prior ${entry.id} preset was user-authored; leaving it in place`)
    } else if (presetOwnedByUs(entry)) {
      removePreset(entry)
    }
  }
  runPnpm(['remove', PLUGIN], profileDir)
  console.log(`install-local: uninstalled ${PLUGIN}; backup at ${join(backupRoot, stamp)}`)
}

function rollback(stamp) {
  if (!stamp) throw new Error('--rollback requires a timestamp')
  if (desktopRunning()) {
    throw new Error('rollback: quit DSH Desktop first so stored sessions are repaired before the compatibility shim is removed')
  }
  repairSessionEvents(repairPaths())
  const source = join(backupRoot, stamp)
  const statePath = join(source, 'state.json')
  if (!existsSync(statePath)) throw new Error(`backup not found: ${source}`)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const presets = state.presets ?? {
    [PRESET_ID]: { dir: presetDir, existed: state.presetExisted, owned: state.presetOwnedByUs },
  }
  // Validate EVERY prior preset before mutating anything: an interrupted or
  // incomplete backup must not produce a mixed restore.
  const plan = []
  for (const entry of OWNED_PRESETS) {
    const prior = presets[entry.id]
    if (prior === undefined) continue
    const backupDir = join(source, `preset-${entry.id}`)
    if (prior.existed && !existsSync(backupDir)) {
      throw new Error(`backup is missing preset-${entry.id}; refusing a partial restore`)
    }
    plan.push({ entry, prior, backupDir })
  }
  for (const file of readdirSync(join(source, 'profile'))) {
    cpSync(join(source, 'profile', file), join(profileDir, file))
  }
  for (const { entry, prior, backupDir } of plan) {
    const dir = presetDirOf(entry)
    if (prior.existed) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      cpSync(backupDir, dir, { recursive: true, dereference: false })
      console.log(`install-local: ${entry.id} preset restored from backup`)
    } else if (existsSync(dir) && presetOwnedByUs(entry)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`install-local: removed ${entry.id} preset that did not exist before the backup`)
    }
  }
  runPnpm(['install'], profileDir)
  console.log(`install-local: profile restored from ${source}`)
}

function listBackups() {
  if (!existsSync(backupRoot)) {
    console.log('install-local: no backups')
    return
  }
  for (const stamp of readdirSync(backupRoot).sort()) {
    if (existsSync(join(backupRoot, stamp, 'state.json'))) console.log(stamp)
  }
}

// Every accepted flag, with whether it takes a value. Retired Builder-route
// flags are gone: an unknown flag fails clearly instead of doing nothing.
const FLAGS = [
  { name: '--tarball', value: true },
  { name: '--profile', value: true },
  { name: '--rollback', value: true },
  { name: '--force', value: false },
  { name: '--uninstall', value: false },
  { name: '--list-backups', value: false },
]
function rejectUnknownFlags() {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const known = FLAGS.find((entry) => entry.name === arg)
    if (known === undefined) {
      throw new Error(`unknown flag ${arg}; supported flags: ${FLAGS.map((entry) => entry.name).join(', ')} (the Builder-route flags were retired with the peer model)`)
    }
    if (known.value && (args[i + 1] === undefined || args[i + 1].startsWith('--'))) {
      throw new Error(`${arg} requires a value`)
    }
  }
}

try {
  rejectUnknownFlags()
} catch (error) {
  console.error(`install-local: ${String(error.message)}`)
  process.exit(1)
}

if (args.includes('--uninstall')) uninstall()
else if (args.includes('--rollback')) rollback(flag('--rollback'))
else if (args.includes('--list-backups')) listBackups()
else install(flag('--tarball'), { force: args.includes('--force') })

export { latestBackup }
