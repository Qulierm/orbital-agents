#!/usr/bin/env node
/**
 * Safe local installer for the dsh-endeavour tarball.
 *
 * Usage:
 *   node scripts/install-local.mjs --tarball <path> [--profile desktop]
 *   node scripts/install-local.mjs --uninstall
 *   node scripts/install-local.mjs --rollback <timestamp>
 *
 * Never uses sudo, never edits the Desktop app bundle, never touches
 * Gatekeeper/quarantine settings.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const PLUGIN = 'dsh-endeavour'
const args = process.argv.slice(2)

function flag(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const profileName = flag('--profile') ?? 'desktop'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)
const backupRoot = join(homedir(), '.dsh', 'backups', 'endeavour')

function run(command, commandArgs, cwd) {
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit' })
}

function readManifest() {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
}

function writeManifest(manifest) {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupRoot, stamp)
  mkdirSync(target, { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml']) {
    const source = join(profileDir, file)
    if (existsSync(source)) cpSync(source, join(target, file))
  }
  console.log(`install-local: backup written to ${target}`)
  return stamp
}

function install(tarball) {
  if (!existsSync(profileDir)) throw new Error(`profile not found: ${profileDir}`)
  if (!tarball || !existsSync(resolve(tarball))) throw new Error(`tarball not found: ${String(tarball)}`)
  const stamp = backup()
  const absolute = resolve(tarball)
  run('pnpm', ['add', absolute], profileDir)
  const manifest = readManifest()
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('profile manifest has no dsh.profile.bundles array')
  if (!bundles.includes(PLUGIN)) {
    bundles.push(PLUGIN)
    writeManifest(manifest)
    console.log(`install-local: added ${PLUGIN} to dsh.profile.bundles (order preserved)`)
  }
  console.log(`install-local: installed ${basename(absolute)}; restart DSH Desktop if it is running`)
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
  run('pnpm', ['remove', PLUGIN], profileDir)
  console.log(`install-local: uninstalled ${PLUGIN}; backup at ${join(backupRoot, stamp)}`)
}

function rollback(stamp) {
  if (!stamp) throw new Error('--rollback requires a timestamp')
  const source = join(backupRoot, stamp)
  if (!existsSync(source)) throw new Error(`backup not found: ${source}`)
  for (const file of readdirSync(source)) cpSync(join(source, file), join(profileDir, file))
  run('pnpm', ['install'], profileDir)
  console.log(`install-local: profile restored from ${source}`)
}

if (args.includes('--uninstall')) uninstall()
else if (args.includes('--rollback')) rollback(flag('--rollback'))
else install(flag('--tarball'))
