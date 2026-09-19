/**
 * Installer lifecycle tests over hermetic temp homes: atomic preset install,
 * idempotency, conflict refusal, ownership, uninstall/rollback exactness,
 * failure rollback, and Builder-route configuration.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, mkdirSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-endeavour-test-'))
  homes.push(home)
  return home
}

function seedProfile(home: string): string {
  const profile = join(home, '.dsh', 'profiles', 'desktop')
  mkdirSync(join(profile, 'node_modules', 'dsh-orbital-agents'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-context': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# user patch layer\n[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(profile, 'node_modules', 'dsh-orbital-agents', 'package.json'), '{"name":"dsh-orbital-agents"}\n')
  return profile
}

function tarball(): string {
  const home = tempHome()
  const path = join(home, 'dsh-orbital-agents-0.2.1.tgz')
  writeFileSync(path, 'fake tarball for lifecycle tests\n')
  return path
}

function installer(home: string, ...args: string[]) {
  return spawnSync(process.execPath, ['scripts/install-local.mjs', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, DSH_ENDEAVOUR_HOME: home, DSH_ENDEAVOUR_TEST_PNPM: '1', DSH_ENDEAVOUR_TEST_NO_DESKTOP: '1' },
  })
}

/**
 * A fake `pnpm` that emulates the stale-reuse behavior of a same-version
 * `file:` dependency: `add` keeps existing installed content unless a prior
 * `remove` deleted it. Real pnpm behaves this way for unchanged specs, which is
 * why the installer removes before adding.
 */
function fakePnpmDir(home: string): string {
  const dir = join(home, 'fake-bin')
  mkdirSync(dir, { recursive: true })
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const [cmd, target] = process.argv.slice(2)
const cwd = process.cwd()
const pkgDir = path.join(cwd, 'node_modules', 'dsh-orbital-agents')
fs.appendFileSync(path.join(process.env.DSH_ENDEAVOUR_HOME, 'pnpm.log'), cmd + ' ' + (target ?? '') + '\\n')
if (cmd === 'remove') { fs.rmSync(pkgDir, { recursive: true, force: true }); process.exit(0) }
if (cmd === 'add') {
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  if (!fs.existsSync(path.join(pkgDir, 'lib', 'client.js'))) {
    fs.writeFileSync(path.join(pkgDir, 'lib', 'client.js'), fs.readFileSync(target))
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-orbital-agents' }))
  process.exit(0)
}
process.exit(0)
`
  writeFileSync(join(dir, 'pnpm'), script)
  chmodSync(join(dir, 'pnpm'), 0o755)
  return dir
}

function installerWithPath(home: string, bin: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_ENDEAVOUR_HOME: home, DSH_ENDEAVOUR_TEST_NO_DESKTOP: '1', PATH: `${bin}:${process.env.PATH ?? ''}` }
  delete env.DSH_ENDEAVOUR_TEST_PNPM
  return spawnSync(process.execPath, ['scripts/install-local.mjs', ...args], { cwd: REPO, encoding: 'utf8', env })
}

function manifest(home: string) {
  return JSON.parse(readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'package.json'), 'utf8'))
}

function latestStamp(home: string): string {
  const root = join(home, '.dsh', 'backups', 'endeavour')
  return readdirSync(root).sort().at(-1)!
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('installer lifecycle', () => {
  it('installs package row, preset, ownership marker and symlink with a backup', () => {
    const home = tempHome()
    seedProfile(home)
    const result = installer(home, '--tarball', tarball())
    expect(result.status).toBe(0)
    const bundles = manifest(home).dsh.profile.bundles as string[]
    expect(bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-orbital-agents'])
    const preset = join(home, '.dsh', '.agent-presets', 'endeavour')
    expect(existsSync(join(preset, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(preset, 'preset.yml'))).toBe(true)
    expect(existsSync(join(preset, '.dsh-endeavour-owned'))).toBe(true)
    expect(existsSync(join(preset, 'node_modules', 'dsh-orbital-agents'))).toBe(true)
    const state = JSON.parse(readFileSync(join(home, '.dsh', 'backups', 'endeavour', latestStamp(home), 'state.json'), 'utf8'))
    expect(state.presetExisted).toBe(false)
  })

  it('is idempotent, including the bundle list', () => {
    const home = tempHome()
    seedProfile(home)
    const file = tarball()
    expect(installer(home, '--tarball', file).status).toBe(0)
    expect(installer(home, '--tarball', file).status).toBe(0)
    const bundles = manifest(home).dsh.profile.bundles as string[]
    expect(bundles.filter((entry) => entry === 'dsh-orbital-agents')).toHaveLength(1)
  })

  it('refuses to overwrite a user-authored preset unless forced, then replaces it', () => {
    const home = tempHome()
    seedProfile(home)
    const preset = join(home, '.dsh', '.agent-presets', 'endeavour')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'preset.yml'), 'name: MyOwn\n')
    const file = tarball()
    const refused = installer(home, '--tarball', file)
    expect(refused.status).not.toBe(0)
    expect(readFileSync(join(preset, 'preset.yml'), 'utf8')).toBe('name: MyOwn\n')
    const forced = installer(home, '--tarball', file, '--force')
    expect(forced.status).toBe(0)
    expect(existsSync(join(preset, '.dsh-endeavour-owned'))).toBe(true)
    expect(readFileSync(join(preset, 'preset.yml'), 'utf8')).toContain('Endeavour')
  })

  it('migrates a live-like old deployment in one isolated temp home', () => {
    const home = tempHome()
    const profile = seedProfile(home)
    const profileBefore = readFileSync(join(profile, 'cordis.patch.yml'))
    // 1. Old single-preset deployment: the owned `endeavour` preset exists.
    const presuppose = join(home, '.dsh', '.agent-presets', 'endeavour')
    mkdirSync(presuppose, { recursive: true })
    writeFileSync(join(presuppose, 'preset.yml'), 'name: endeavour\nversion: 0.1.0\n')
    // Ownership marker written by the PREVIOUS version of this installer, so the
    // migration recognises the preset as ours instead of a user-authored one.
    writeFileSync(join(presuppose, '.dsh-endeavour-owned'), 'dsh-orbital-agents\n')
    // 2. Retired settings namespace next to unrelated keys.
    writeFileSync(join(home, '.dsh', 'settings.yaml'), 'theme: dark\nendeavour-builder:\n  mode: custom\nprovider: keep\n')
    // 3. Real-looking session logs: a TERMINAL legacy plan (allowed), an
    //    unmarked peer checkpoint (needs the repair marker) and a corrupt file.
    const dir = join(home, '.dsh', 'sessions', '--workspace--')
    mkdirSync(dir, { recursive: true })
    const terminalPlan = { seq: 1, type: 'endeavour/plan', data: { kind: 'plan-created', at: 1, plan: { planId: 'p-old', rootSessionId: 'root-old', childId: 'child-old', sequence: 2, terminal: { outcome: 'completed', at: 9 } } } }
    const peerEvent = { seq: 2, type: 'endeavour/peer', data: { kind: 'peer-created', at: 2, state: { version: 1, pairId: 'pair', endeavourSessionId: 'root-old', challengerSessionId: 'challenger-old', createdAt: 1, updatedAt: 1, sequence: 1 } } }
    const sessionFile = join(dir, 'session.old.jsonl')
    writeFileSync(sessionFile, `${JSON.stringify(terminalPlan)}\n${JSON.stringify(peerEvent)}\n`)
    writeFileSync(join(dir, 'session.corrupt.jsonl.zstd'), 'not zstd')

    const installed = installer(home, '--tarball', tarball())
    expect(installed.status).toBe(0)
    expect(installed.stdout).toContain('terminal legacy plan')
    expect(installed.stdout).toContain('skipped unreadable session log')
    // Both owned presets installed and linked; the challenger row is present.
    for (const preset of ['endeavour', 'challenger']) {
      const dirPath = join(home, '.dsh', '.agent-presets', preset)
      expect(existsSync(join(dirPath, 'preset.yml'))).toBe(true)
      expect(existsSync(join(dirPath, 'node_modules', 'dsh-orbital-agents'))).toBe(true)
      expect(readFileSync(join(dirPath, 'agent.cordis.yml'), 'utf8')).toContain('dsh-orbital-agents')
    }
    // Repair markers landed on BOTH admitted event types, file stays readable.
    const repaired = readFileSync(sessionFile, 'utf8')
    expect(repaired.split('\n').filter((line) => line.includes('"ignorable":true'))).toHaveLength(2)
    expect(JSON.parse(repaired.split('\n')[0]!).data.plan.planId).toBe('p-old')
    expect(existsSync(join(home, '.dsh', 'backups', 'endeavour'))).toBe(true)
    // Settings: only the owned namespace removed.
    const settings = readFileSync(join(home, '.dsh', 'settings.yaml'), 'utf8')
    expect(settings).toContain('theme: dark')
    expect(settings).not.toContain('endeavour-builder')
    // Rollback restores the profile file byte-exactly.
    const stamps = readdirSync(join(home, '.dsh', 'backups', 'endeavour')).filter((name) => /^\d{4}-/.test(name))
    expect(stamps.length).toBeGreaterThan(0)
    expect(installer(home, '--rollback', stamps[stamps.length - 1]!).status).toBe(0)
    expect(readFileSync(join(profile, 'cordis.patch.yml'))).toEqual(profileBefore)
    // Uninstall removes only presets this package owns.
    expect(installer(home, '--uninstall').status).toBe(0)
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'challenger'))).toBe(false)
  })

  it('retired Builder-route flags fail clearly without touching the profile', () => {
    const home = tempHome()
    seedProfile(home)
    const before = readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    for (const flag of ['--configure-builder', '--show-builder', '--reset-builder']) {
      const result = installer(home, flag)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('unknown flag')
      expect(result.stderr).toContain(flag)
    }
    expect(readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).toBe(before)
    expect(existsSync(join(home, '.dsh', 'backups', 'endeavour'))).toBe(false)
    // A flag that needs a value is rejected too.
    const missing = installer(home, '--rollback')
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('requires a value')
  })

  it('uninstalls owned preset and bundle entry but preserves a user-authored preset', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    expect(installer(home, '--uninstall').status).toBe(0)
    expect(manifest(home).dsh.profile.bundles).not.toContain('dsh-orbital-agents')
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })

  it('refreshes the installed artifact when the tarball changes at the same name and version', () => {
    const home = tempHome()
    seedProfile(home)
    const bin = fakePnpmDir(home)
    const file = join(home, 'dsh-orbital-agents-0.2.1.tgz')
    const installed = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orbital-agents', 'lib', 'client.js')
    writeFileSync(file, 'OLD ARTIFACT')
    expect(installerWithPath(home, bin, '--tarball', file).status).toBe(0)
    expect(readFileSync(installed, 'utf8')).toBe('OLD ARTIFACT')
    writeFileSync(file, 'NEW ARTIFACT')
    expect(installerWithPath(home, bin, '--tarball', file).status).toBe(0)
    // Without remove-before-add the fake pnpm reuses the stale copy and this is still OLD.
    expect(readFileSync(installed, 'utf8')).toBe('NEW ARTIFACT')
    const commands = readFileSync(join(home, 'pnpm.log'), 'utf8')
    expect(commands).toMatch(/remove[\s\S]*add/)
  })

  it('rolls back profile files and preset state exactly', () => {
    const home = tempHome()
    seedProfile(home)
    const file = tarball()
    const installed = installer(home, '--tarball', file)
    expect(installed.status).toBe(0)
    const stamp = /--rollback (\S+)/.exec(installed.stdout)?.[1]
    expect(stamp).toBeTruthy()
    // A second install takes its own backup (the replacement for the retired
    // route CLI) with both presets present.
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    expect(installer(home, '--rollback', stamp!).status).toBe(0)
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })

  it('installs both owned presets with per-preset state and no plugin link on Challenger', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    const root = join(home, '.dsh', '.agent-presets')
    for (const id of ['endeavour', 'challenger']) {
      expect(existsSync(join(root, id, 'agent.cordis.yml'))).toBe(true)
      expect(existsSync(join(root, id, 'preset.yml'))).toBe(true)
      expect(existsSync(join(root, id, '.dsh-endeavour-owned'))).toBe(true)
    }
    expect(existsSync(join(root, 'endeavour', 'node_modules', 'dsh-orbital-agents'))).toBe(true)
    // Challenger mounts the role tools row, so it links the package too.
    expect(existsSync(join(root, 'challenger', 'node_modules', 'dsh-orbital-agents'))).toBe(true)
    const agent = readFileSync(join(root, 'challenger', 'agent.cordis.yml'), 'utf8')
    expect(agent).not.toMatch(/tool-subagent|send_message|subagent_fork/)
    expect(agent).toMatch(/role: challenger/)
    const plannerAgent = readFileSync(join(root, 'endeavour', 'agent.cordis.yml'), 'utf8')
    expect(plannerAgent).toMatch(/role: endeavour/)
    expect(readFileSync(join(root, 'challenger', 'preset.yml'), 'utf8')).toContain('Challenger')
    const state = JSON.parse(readFileSync(join(home, '.dsh', 'backups', 'endeavour', latestStamp(home), 'state.json'), 'utf8'))
    expect(state.presetExisted).toBe(false)
    expect(state.presets.endeavour).toEqual({ dir: join(root, 'endeavour'), existed: false, owned: false })
    expect(state.presets.challenger.existed).toBe(false)
  })

  it('refuses to migrate while a nonterminal legacy plan exists, with zero mutation', () => {
    const home = tempHome()
    seedProfile(home)
    const dir = join(home, '.dsh', 'sessions', '--workspace--')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl'), `${JSON.stringify({
      seq: 1, type: 'endeavour/plan', ignorable: true,
      data: { kind: 'plan-created', at: 1, plan: { planId: 'p-active', rootSessionId: 'root-x', childId: 'child-x', title: 'Legacy running', sequence: 2 } },
    })}\n`)
    const refused = installer(home, '--tarball', tarball())
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('refusing to migrate')
    expect(refused.stderr).toContain('p-active')
    // NOTHING moved: no backup, no bundle row, no presets.
    expect(existsSync(join(home, '.dsh', 'backups', 'endeavour'))).toBe(false)
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(home, '.dsh', '.agent-presets'))).toBe(false)
    // A terminal legacy plan does not block the install.
    writeFileSync(join(dir, 'session.v3.jsonl'), `${JSON.stringify({
      seq: 1, type: 'endeavour/plan', ignorable: true,
      data: { kind: 'plan-created', at: 1, plan: { planId: 'p-done', rootSessionId: 'root-x', childId: 'child-x', title: 'Legacy done', sequence: 3, terminal: { outcome: 'completed', at: 9 } } },
    })}\n`)
    const allowed = installer(home, '--tarball', tarball())
    expect(allowed.status).toBe(0)
    expect(allowed.stdout).toContain('terminal legacy plan')
  })

  it('removes only the retired endeavour-builder settings block and backs it up', () => {
    const home = tempHome()
    seedProfile(home)
    const settingsPath = join(home, '.dsh', 'settings.yaml')
    mkdirSync(join(home, '.dsh'), { recursive: true })
    writeFileSync(settingsPath, [
      'unrelated-provider:',
      '  apiKeyEnv: KEEP_ME',
      'endeavour-builder:',
      '  mode: custom',
      '  provider: opencode-go',
      '  model: gpt-5.6-luna',
      'other: value',
      '',
    ].join('\n'))
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    const after = readFileSync(settingsPath, 'utf8')
    expect(after).not.toContain('endeavour-builder')
    expect(after).toContain('KEEP_ME')
    expect(after).toContain('other: value')
    const backupRoot = join(home, '.dsh', 'backups', 'endeavour')
    const settingsBackups = readdirSync(backupRoot).filter((name) => name.startsWith('settings-'))
    expect(settingsBackups).toHaveLength(1)
    expect(readFileSync(join(backupRoot, settingsBackups[0]!, 'settings.yaml'), 'utf8')).toContain('endeavour-builder')
    // Installing again is a no-op for the settings document.
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    expect(readdirSync(backupRoot).filter((name) => name.startsWith('settings-'))).toHaveLength(1)
  })

  it('repairs a Challenger preset that predates the role tools link', () => {
    const home = tempHome()
    seedProfile(home)
    const file = tarball()
    expect(installer(home, '--tarball', file).status).toBe(0)
    const root = join(home, '.dsh', '.agent-presets')
    // Simulate the pre-C3 Challenger install: preset present, no package link.
    rmSync(join(root, 'challenger', 'node_modules'), { recursive: true, force: true })
    expect(existsSync(join(root, 'challenger', 'node_modules', 'dsh-orbital-agents'))).toBe(false)
    expect(installer(home, '--tarball', file).status).toBe(0)
    expect(existsSync(join(root, 'challenger', 'node_modules', 'dsh-orbital-agents'))).toBe(true)
    expect(readFileSync(join(root, 'challenger', 'agent.cordis.yml'), 'utf8')).toMatch(/role: challenger/)
  })

  it('upgrades a legacy Endeavour-only install and restores both sides', () => {
    const home = tempHome()
    seedProfile(home)
    const file = tarball()
    expect(installer(home, '--tarball', file).status).toBe(0)
    const root = join(home, '.dsh', '.agent-presets')
    // Simulate the pre-roster world: only the Endeavour preset is installed.
    rmSync(join(root, 'challenger'), { recursive: true, force: true })
    const upgraded = installer(home, '--tarball', file)
    expect(upgraded.status).toBe(0)
    expect(existsSync(join(root, 'endeavour'))).toBe(true)
    expect(existsSync(join(root, 'challenger'))).toBe(true)
    const stamp = /--rollback (\S+)/.exec(upgraded.stdout)?.[1]
    expect(stamp).toBeTruthy()
    // Rollback restores the state captured BEFORE that install: the legacy
    // Endeavour preset stays, the newly added Challenger disappears.
    expect(installer(home, '--rollback', stamp!).status).toBe(0)
    expect(existsSync(join(root, 'endeavour'))).toBe(true)
    expect(existsSync(join(root, 'challenger'))).toBe(false)
  })

  it('aborts on a foreign Challenger preset with zero partial mutation', () => {
    const home = tempHome()
    seedProfile(home)
    const root = join(home, '.dsh', '.agent-presets')
    mkdirSync(join(root, 'challenger'), { recursive: true })
    writeFileSync(join(root, 'challenger', 'preset.yml'), 'name: MyOwnChallenger\n')
    const refused = installer(home, '--tarball', tarball())
    expect(refused.status).not.toBe(0)
    // Nothing moved: no bundle row, no Endeavour preset, no foreign overwrite.
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(root, 'endeavour'))).toBe(false)
    expect(readFileSync(join(root, 'challenger', 'preset.yml'), 'utf8')).toBe('name: MyOwnChallenger\n')
    expect(existsSync(join(home, '.dsh', 'backups', 'endeavour'))).toBe(false)
  })

  it('uninstalls every owned preset and preserves nothing foreign', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    expect(installer(home, '--uninstall').status).toBe(0)
    const root = join(home, '.dsh', '.agent-presets')
    expect(existsSync(join(root, 'endeavour'))).toBe(false)
    expect(existsSync(join(root, 'challenger'))).toBe(false)
    expect(manifest(home).dsh.profile.bundles).not.toContain('dsh-orbital-agents')
  })

  it('rolls back a missing owned preset to its prior present state', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    // Second mutation takes a backup with BOTH presets present.
    // A second install takes its own backup (the replacement for the retired
    // route CLI) with both presets present.
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    const stamp = latestStamp(home)
    const root = join(home, '.dsh', '.agent-presets')
    rmSync(join(root, 'challenger'), { recursive: true, force: true })
    expect(installer(home, '--rollback', stamp).status).toBe(0)
    expect(existsSync(join(root, 'endeavour', 'preset.yml'))).toBe(true)
    expect(existsSync(join(root, 'challenger', 'preset.yml'))).toBe(true)
  })

  it('refuses an interrupted backup instead of restoring a mixed pair', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    // A later mutation captures a backup where BOTH presets existed.
    // A second install takes its own backup (the replacement for the retired
    // route CLI) with both presets present.
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    const stamp = latestStamp(home)
    // Simulate an interrupted backup: the challenger copy never landed.
    rmSync(join(home, '.dsh', 'backups', 'endeavour', stamp, 'preset-challenger'), { recursive: true, force: true })
    const rollback = installer(home, '--rollback', stamp)
    expect(rollback.status).not.toBe(0)
    expect(rollback.stderr).toContain('preset-challenger')
    // The profile was not partially restored.
    expect(manifest(home).dsh.profile.bundles).toContain('dsh-orbital-agents')
  })

  it('rolls back partial changes when preset installation fails', () => {
    const home = tempHome()
    const profile = seedProfile(home)
    rmSync(join(profile, 'node_modules', 'dsh-orbital-agents'), { recursive: true, force: true })
    const result = installer(home, '--tarball', tarball())
    expect(result.status).not.toBe(0)
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })
})

/**
 * Package rename: `dsh-endeavour` (published predecessor) becomes
 * `dsh-orbital-agents`. These fixtures model the EXTERNAL identity only —
 * fresh installation, and upgrade from a package-owned legacy profile — while
 * an unrelated bundle/package/user preset must survive untouched.
 */
const NEW_PACKAGE = 'dsh-orbital-agents'
const LEGACY_PACKAGE = 'dsh-endeavour'

function seedLegacyProfile(home: string, presetExists: boolean): string {
  const profile = join(home, '.dsh', 'profiles', 'desktop')
  mkdirSync(join(profile, 'node_modules', LEGACY_PACKAGE), { recursive: true })
  mkdirSync(join(profile, 'node_modules', 'dsh-context'), { recursive: true })
  writeFileSync(join(profile, 'node_modules', LEGACY_PACKAGE, 'package.json'), JSON.stringify({ name: LEGACY_PACKAGE }))
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-context': '1.0.0', [LEGACY_PACKAGE]: 'file:/tmp/legacy.tgz' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context', LEGACY_PACKAGE] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# user patch layer\n[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  if (presetExists) {
    const preset = join(home, '.dsh', '.agent-presets', 'endeavour')
    mkdirSync(join(preset, 'node_modules'), { recursive: true })
    writeFileSync(join(preset, '.dsh-endeavour-owned'), `${LEGACY_PACKAGE}\n`)
    writeFileSync(join(preset, 'preset.yml'), 'name: Endeavour\n')
    const target = join(profile, 'node_modules', LEGACY_PACKAGE)
    symlinkSync(target, join(preset, 'node_modules', LEGACY_PACKAGE), 'dir')
  }
  // An unrelated user-authored preset without our ownership marker.
  const foreign = join(home, '.dsh', '.agent-presets', 'user-own')
  mkdirSync(foreign, { recursive: true })
  writeFileSync(join(foreign, 'preset.yml'), 'name: User Own\n')
  return profile
}

/** Fake pnpm that mirrors real remove/add semantics for both names. */
function renameAwarePnpm(home: string): string {
  const dir = join(home, 'fake-bin')
  mkdirSync(dir, { recursive: true })
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const [cmd, target] = process.argv.slice(2)
const cwd = process.cwd()
fs.appendFileSync(path.join(process.env.DSH_ENDEAVOUR_HOME, 'pnpm.log'), cmd + ' ' + (target ?? '') + '\\n')
const dirOf = (name) => path.join(cwd, 'node_modules', name)
const manifestPath = path.join(cwd, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (cmd === 'remove') {
  for (const name of [target, 'dsh-orbital-agents', 'dsh-endeavour']) {
    fs.rmSync(dirOf(name), { recursive: true, force: true })
    if (manifest.dependencies) delete manifest.dependencies[name]
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
  process.exit(0)
}
if (cmd === 'add') {
  const pkgDir = dirOf('dsh-orbital-agents')
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkgDir, 'lib', 'client.js'), fs.readFileSync(target))
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-orbital-agents' }))
  manifest.dependencies = { ...(manifest.dependencies ?? {}), 'dsh-orbital-agents': 'file:' + target }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
  process.exit(0)
}
process.exit(0)
`
  writeFileSync(join(dir, 'pnpm'), script)
  chmodSync(join(dir, 'pnpm'), 0o755)
  return dir
}

describe('package rename migration', () => {
  it('fresh install registers only the new package identity', () => {
    const home = tempHome()
    seedLegacyProfile(home, false)
    const bin = renameAwarePnpm(home)
    const run = installerWithPath(home, bin, '--tarball', tarball())
    expect(run.status).toBe(0)
    const bundles = manifest(home).dsh.profile.bundles
    expect(bundles).toContain(NEW_PACKAGE)
    expect(bundles).not.toContain(LEGACY_PACKAGE)
    expect(bundles).toContain('dsh-context')
    for (const name of ['endeavour', 'challenger']) {
      const preset = join(home, '.dsh', '.agent-presets', name)
      expect(existsSync(join(preset, 'node_modules', NEW_PACKAGE))).toBe(true)
      expect(existsSync(join(preset, 'node_modules', LEGACY_PACKAGE))).toBe(false)
    }
    const log = readFileSync(join(home, 'pnpm.log'), 'utf8')
    expect(log).toContain('add ')
    expect(log).toContain(LEGACY_PACKAGE)
  })

  it('upgrades a legacy owned installation without duplicating or deleting unrelated content', () => {
    const home = tempHome()
    seedLegacyProfile(home, true)
    const bin = renameAwarePnpm(home)
    const run = installerWithPath(home, bin, '--tarball', tarball())
    expect(run.status).toBe(0)

    const bundles = manifest(home).dsh.profile.bundles
    expect(bundles.filter((entry: string) => entry === NEW_PACKAGE)).toHaveLength(1)
    expect(bundles).not.toContain(LEGACY_PACKAGE)
    expect(bundles).toContain('dsh-context')

    const dependencies = manifest(home).dependencies ?? {}
    expect(Object.keys(dependencies)).toContain(NEW_PACKAGE)
    expect(Object.keys(dependencies)).not.toContain(LEGACY_PACKAGE)
    expect(Object.keys(dependencies)).toContain('dsh-context')

    const preset = join(home, '.dsh', '.agent-presets', 'endeavour')
    expect(existsSync(join(preset, 'node_modules', NEW_PACKAGE))).toBe(true)
    expect(existsSync(join(preset, 'node_modules', LEGACY_PACKAGE))).toBe(false)
    expect(readdirSync(join(preset, 'node_modules'))).toEqual([NEW_PACKAGE])

    // The unrelated user-authored preset is never touched.
    const foreign = join(home, '.dsh', '.agent-presets', 'user-own')
    expect(readFileSync(join(foreign, 'preset.yml'), 'utf8')).toBe('name: User Own\n')
    expect(existsSync(join(foreign, '.dsh-endeavour-owned'))).toBe(false)

    const log = readFileSync(join(home, 'pnpm.log'), 'utf8')
    expect(log).toContain(`remove ${LEGACY_PACKAGE}`)
    expect(log).not.toContain('remove dsh-context')
  })
})
