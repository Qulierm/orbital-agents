/**
 * Installer lifecycle tests over hermetic temp homes: atomic preset install,
 * idempotency, conflict refusal, ownership, uninstall/rollback exactness,
 * failure rollback, and Builder-route configuration.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync,
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
  mkdirSync(join(profile, 'node_modules', 'dsh-endeavour'), { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'dsh-context': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '# user patch layer\n[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
  writeFileSync(join(profile, 'node_modules', 'dsh-endeavour', 'package.json'), '{"name":"dsh-endeavour"}\n')
  return profile
}

function tarball(): string {
  const home = tempHome()
  const path = join(home, 'dsh-endeavour-0.1.0.tgz')
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
const pkgDir = path.join(cwd, 'node_modules', 'dsh-endeavour')
fs.appendFileSync(path.join(process.env.DSH_ENDEAVOUR_HOME, 'pnpm.log'), cmd + ' ' + (target ?? '') + '\\n')
if (cmd === 'remove') { fs.rmSync(pkgDir, { recursive: true, force: true }); process.exit(0) }
if (cmd === 'add') {
  fs.mkdirSync(path.join(pkgDir, 'lib'), { recursive: true })
  if (!fs.existsSync(path.join(pkgDir, 'lib', 'client.js'))) {
    fs.writeFileSync(path.join(pkgDir, 'lib', 'client.js'), fs.readFileSync(target))
  }
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-endeavour' }))
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
    expect(bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context', 'dsh-endeavour'])
    const preset = join(home, '.dsh', '.agent-presets', 'endeavour')
    expect(existsSync(join(preset, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(preset, 'preset.yml'))).toBe(true)
    expect(existsSync(join(preset, '.dsh-endeavour-owned'))).toBe(true)
    expect(existsSync(join(preset, 'node_modules', 'dsh-endeavour'))).toBe(true)
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
    expect(bundles.filter((entry) => entry === 'dsh-endeavour')).toHaveLength(1)
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

  it('configures, displays, and resets only the Endeavour Builder route', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    const configured = installer(home, '--configure-builder', '--provider', 'acme', '--model', 'fast-1', '--max-tokens', '32000')
    expect(configured.status).toBe(0)
    const patch = readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('builderAgentOptions')
    expect(patch).toContain('fast-1')
    const shown = installer(home, '--show-builder')
    expect(shown.stdout).toContain('configured provider=acme model=fast-1')
    const invalid = installer(home, '--configure-builder', '--provider', 'acme', '--model', '')
    expect(invalid.status).not.toBe(0)
    expect(readFileSync(join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).toContain('fast-1')
    expect(installer(home, '--reset-builder').status).toBe(0)
    expect(installer(home, '--show-builder').stdout).toContain('inherited')
  })

  it('uninstalls owned preset and bundle entry but preserves a user-authored preset', () => {
    const home = tempHome()
    seedProfile(home)
    expect(installer(home, '--tarball', tarball()).status).toBe(0)
    expect(installer(home, '--uninstall').status).toBe(0)
    expect(manifest(home).dsh.profile.bundles).not.toContain('dsh-endeavour')
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })

  it('refreshes the installed artifact when the tarball changes at the same name and version', () => {
    const home = tempHome()
    seedProfile(home)
    const bin = fakePnpmDir(home)
    const file = join(home, 'dsh-endeavour-0.1.0.tgz')
    const installed = join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-endeavour', 'lib', 'client.js')
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
    expect(installer(home, '--configure-builder', '--provider', 'acme', '--model', 'fast-1').status).toBe(0)
    expect(installer(home, '--rollback', stamp!).status).toBe(0)
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })

  it('rolls back partial changes when preset installation fails', () => {
    const home = tempHome()
    const profile = seedProfile(home)
    rmSync(join(profile, 'node_modules', 'dsh-endeavour'), { recursive: true, force: true })
    const result = installer(home, '--tarball', tarball())
    expect(result.status).not.toBe(0)
    expect(manifest(home).dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-context'])
    expect(existsSync(join(home, '.dsh', '.agent-presets', 'endeavour'))).toBe(false)
  })
})
