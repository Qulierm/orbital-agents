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

const PLUGIN = 'dsh-endeavour'
const PRESET_ID = 'endeavour'
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
const presetDir = join(presetRoot, PRESET_ID)
const backupRoot = join(homeBase, '.dsh', 'backups', 'endeavour')
const packageRoot = resolve(import.meta.dirname, '..')

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

function readPatchFile(path) {
  if (!existsSync(path)) return []
  const parsed = load(readFileSync(path, 'utf8'))
  return Array.isArray(parsed) ? parsed : []
}

function writePatchFile(path, entries) {
  const header = `# Your patch layer for this dsh profile, applied after every bundle layer:\n`
    + `# managed entries for ${PLUGIN} appear below; keep other edits intact.\n`
  writeFileSync(path, header + dump(entries, { lineWidth: 120 }))
}

/** Copy a directory to a fresh atomic location then swap it in. */
function atomicReplaceDir(source, target) {
  const staging = `${target}.staging-${timestamp()}`
  cpSync(source, staging, { recursive: true })
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  renameSync(staging, target)
}

function presetOwnedByUs() {
  return existsSync(join(presetDir, OWNERSHIP_MARKER))
}

function installPreset({ force }) {
  const source = join(packageRoot, 'preset', PRESET_ID)
  if (!existsSync(source)) throw new Error(`preset asset missing: ${source}`)
  if (existsSync(presetDir) && !presetOwnedByUs() && !force) {
    throw new Error(`refusing to overwrite existing user preset at ${presetDir}; re-run with --force to replace it (a backup is taken)`)
  }
  mkdirSync(presetRoot, { recursive: true })
  atomicReplaceDir(source, presetDir)
  writeFileSync(join(presetDir, OWNERSHIP_MARKER), `${PLUGIN}\n`)
  const linkPath = join(presetDir, 'node_modules')
  mkdirSync(linkPath, { recursive: true })
  const packageLink = join(linkPath, PLUGIN)
  rmSync(packageLink, { force: true })
  const installedPackage = join(profileDir, 'node_modules', PLUGIN)
  if (!existsSync(installedPackage)) throw new Error(`installed package missing: ${installedPackage}`)
  symlinkSync(installedPackage, packageLink, 'dir')
  console.log(`install-local: preset installed at ${presetDir}`)
}

function removePreset() {
  if (!existsSync(presetDir)) return false
  if (!presetOwnedByUs()) {
    console.log(`install-local: preset at ${presetDir} is not owned by ${PLUGIN}; leaving it untouched`)
    return false
  }
  rmSync(presetDir, { recursive: true, force: true })
  console.log(`install-local: removed owned preset ${presetDir}`)
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
  const presetExisted = existsSync(presetDir)
  if (presetExisted) cpSync(presetDir, join(target, 'preset'), { recursive: true, dereference: false })
  const priorOwnership = presetExisted && presetOwnedByUs()
  const state = {
    stamp,
    profileDir,
    presetDir,
    presetExisted,
    presetOwnedByUs: priorOwnership,
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

function ensurePatchRow(entries, config) {
  const others = entries.filter((entry) => !(entry && typeof entry === 'object' && entry.id === 'endeavour'))
  return [...others, { id: 'endeavour', name: PLUGIN, config }]
}

function configureBuilder() {
  const provider = flag('--provider')
  const model = flag('--model')
  if (typeof provider !== 'string' || provider.trim() === '' || typeof model !== 'string' || model.trim() === '') {
    throw new Error('--configure-builder requires non-empty --provider and --model; nothing was changed')
  }
  const maxTokensRaw = flag('--max-tokens')
  let maxTokens
  if (maxTokensRaw !== undefined) {
    maxTokens = Number(maxTokensRaw)
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('--max-tokens must be a positive integer')
  }
  backup()
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entries = readPatchFile(patchPath)
  const builderAgentOptions = {
    provider: provider.trim(),
    model: model.trim(),
    ...(flag('--reasoning-effort') === undefined ? {} : { reasoningEffort: flag('--reasoning-effort') }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
  writePatchFile(patchPath, ensurePatchRow(entries, { builderAgentOptions }))
  console.log(`install-local: Builder route set (${builderAgentOptions.provider} / ${builderAgentOptions.model})${maxTokens === undefined ? '' : ` maxTokens=${String(maxTokens)}`}`)
}

function showBuilder() {
  const entries = readPatchFile(join(profileDir, 'cordis.patch.yml'))
  const row = entries.find((entry) => entry && typeof entry === 'object' && entry.id === 'endeavour')
  const options = row?.config?.builderAgentOptions
  if (options === undefined) {
    console.log('Builder route: inherited (no separate provider/model configured; the Builder uses the Planner route)')
    return
  }
  console.log(`Builder route: configured provider=${String(options.provider)} model=${String(options.model)}`
    + `${options.reasoningEffort === undefined ? '' : ` reasoningEffort=${String(options.reasoningEffort)}`}`
    + `${options.maxTokens === undefined ? '' : ` maxTokens=${String(options.maxTokens)}`}`)
}

function resetBuilder() {
  backup()
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const entries = readPatchFile(patchPath).filter((entry) => !(entry && typeof entry === 'object' && entry.id === 'endeavour'))
  writePatchFile(patchPath, entries)
  console.log('install-local: Builder route reset; the Builder inherits the Planner route')
}

function install(tarball, { force }) {
  if (!existsSync(profileDir)) throw new Error(`profile not found: ${profileDir}`)
  if (!tarball || !existsSync(resolve(tarball))) throw new Error(`tarball not found: ${String(tarball)}`)
  const stamp = backup()
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
    installPreset({ force })
  } catch (error) {
    console.error(`install-local: install failed (${String(error.message)}); rolling back to ${stamp}`)
    rollback(stamp)
    throw error
  }
  console.log(`install-local: installed ${PLUGIN}; restart DSH Desktop if it is running`)
  console.log(`install-local: rollback with --rollback ${stamp}`)
}

function uninstall() {
  const stamp = backup()
  const manifest = readManifest()
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((entry) => entry !== PLUGIN)
    writeManifest(manifest)
  }
  const state = JSON.parse(readFileSync(join(backupRoot, stamp, 'state.json'), 'utf8'))
  if (state.presetExisted && state.presetOwnedByUs === false) {
    console.log('install-local: prior preset was user-authored; leaving it in place')
  } else if (presetOwnedByUs()) {
    removePreset()
  }
  runPnpm(['remove', PLUGIN], profileDir)
  console.log(`install-local: uninstalled ${PLUGIN}; backup at ${join(backupRoot, stamp)}`)
}

function rollback(stamp) {
  if (!stamp) throw new Error('--rollback requires a timestamp')
  const source = join(backupRoot, stamp)
  const statePath = join(source, 'state.json')
  if (!existsSync(statePath)) throw new Error(`backup not found: ${source}`)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  for (const file of readdirSync(join(source, 'profile'))) {
    cpSync(join(source, 'profile', file), join(profileDir, file))
  }
  if (state.presetExisted) {
    if (existsSync(presetDir)) rmSync(presetDir, { recursive: true, force: true })
    cpSync(join(source, 'preset'), presetDir, { recursive: true, dereference: false })
    console.log(`install-local: preset restored from backup`)
  } else if (existsSync(presetDir) && presetOwnedByUs()) {
    rmSync(presetDir, { recursive: true, force: true })
    console.log('install-local: removed preset that did not exist before the backup')
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

if (args.includes('--uninstall')) uninstall()
else if (args.includes('--rollback')) rollback(flag('--rollback'))
else if (args.includes('--configure-builder')) configureBuilder()
else if (args.includes('--show-builder')) showBuilder()
else if (args.includes('--reset-builder')) resetBuilder()
else if (args.includes('--list-backups')) listBackups()
else install(flag('--tarball'), { force: args.includes('--force') })

export { latestBackup }
