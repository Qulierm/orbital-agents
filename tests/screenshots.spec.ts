/**
 * Marketplace screenshot contract.
 *
 * The plugin registry reads `screenshots.json` from the repository root and
 * resolves each relative path against the repository at HEAD. The committed
 * images are REAL captures of a running DSH Desktop session, so the rules here
 * describe published bytes rather than generated renders: they pin the
 * declaration, the images, the README agreement, the capture tooling and the
 * fact that none of it ships in the published package.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = resolve(import.meta.dirname, '..')
const DECLARATION = join(REPO, 'screenshots.json')
const SCREENSHOT_DIR = join(REPO, 'assets', 'screenshots')
const CAPTURE = join(REPO, 'scripts', 'screenshots', 'capture.mjs')
const HARNESS = join(REPO, 'scripts', 'screenshots', 'harness.tsx')
const README = join(REPO, 'README.md')

/** The registry caps a declaration at 8 images. */
const REGISTRY_CAP = 8
const PNG_SIGNATURE = '89504e470d0a1a0a'
const MAX_BYTES = 1_500_000
/**
 * Minimum legible size. Real captures are not 2x renders, so the rule is a
 * readability floor rather than an even-dimension check.
 */
const MIN_WIDTH = 400
const MIN_HEIGHT = 100

interface Png {
  readonly width: number
  readonly height: number
  readonly bytes: number
}

function readPng(path: string): Png {
  const buffer = readFileSync(path)
  expect(buffer.subarray(0, 8).toString('hex'), `${path} signature`).toBe(PNG_SIGNATURE)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: statSync(path).size }
}

const declared = JSON.parse(readFileSync(DECLARATION, 'utf8')) as unknown

describe('screenshots declaration', () => {
  it('is an array of at most eight relative in-repo paths', () => {
    expect(Array.isArray(declared)).toBe(true)
    const entries = declared as string[]
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.length).toBeLessThanOrEqual(REGISTRY_CAP)
    for (const entry of entries) {
      expect(typeof entry).toBe('string')
      expect(entry.length).toBeGreaterThan(0)
      // Relative, inside the repository, and never absolute.
      expect(entry.startsWith('/')).toBe(false)
      expect(entry.split('/')).not.toContain('..')
      expect(entry.endsWith('.png')).toBe(true)
    }
    expect(new Set(entries).size).toBe(entries.length)
  })

  it('points at files that exist as readable captures', () => {
    for (const entry of declared as string[]) {
      const path = join(REPO, entry)
      expect(existsSync(path), `${entry} exists`).toBe(true)
      const png = readPng(path)
      expect(png.width, `${entry} width`).toBeGreaterThanOrEqual(MIN_WIDTH)
      expect(png.height, `${entry} height`).toBeGreaterThanOrEqual(MIN_HEIGHT)
      expect(png.bytes, `${entry} size`).toBeLessThan(MAX_BYTES)
    }
  })

  it('declares exactly the committed files, with no orphans either way', () => {
    const onDisk = readdirSync(SCREENSHOT_DIR).filter((name) => name.endsWith('.png')).sort()
    const declaredNames = (declared as string[]).map((entry) => entry.split('/').at(-1)!).sort()
    expect(declaredNames).toEqual(onDisk)
  })

  it('is mirrored exactly by the README image references', () => {
    const readme = readFileSync(README, 'utf8')
    const linked = [...readme.matchAll(/assets\/screenshots\/[A-Za-z0-9._-]+\.png/g)].map((match) => match[0])
    expect(new Set(linked).size).toBe(linked.length)
    expect([...linked].sort()).toEqual([...(declared as string[])].sort())
  })

  it('describes the images as real captures of the running app', () => {
    const readme = readFileSync(README, 'utf8')
    expect(readme).toMatch(/real captures of a running DSH Desktop session/i)
    // No stale claim about generated or fixture-based marketplace images.
    expect(readme).not.toMatch(/synthetic fixture/i)
    expect(readme).not.toMatch(/rendered offline from the plugin's own components against\s+synthetic/i)
  })
})

describe('screenshot harness', () => {
  it('renders the real components rather than reimplementations', () => {
    const harness = readFileSync(HARNESS, 'utf8')
    expect(harness).toContain("from '../../src/client/PlanView.js'")
    expect(harness).toContain("from '../../src/client/UnifiedModelControl.js'")
    expect(harness).toContain("from '../../src/client/styles.js'")
    // Frozen clock: every timer string is deterministic.
    expect(harness).toContain('static override now()')
  })

  it('covers the durable display stages and the interruption mark', () => {
    const harness = readFileSync(HARNESS, 'utf8')
    for (const stage of ["'confirmed'", "'finished'", "'working'", "'waiting'"]) {
      expect(harness, `stage ${stage}`).toContain(stage)
    }
    expect(harness).toContain("'interrupted'")
    expect(harness).toContain("outcome: 'completed'")
  })
})

describe('capture tooling', () => {
  const capture = readFileSync(CAPTURE, 'utf8')

  it('writes to a generated directory by default, never to the committed captures', () => {
    expect(capture).toContain("const DEFAULT_OUT_DIR = join(HERE, 'out')")
    expect(capture).toContain("const COMMITTED_DIR = join(REPO, 'assets', 'screenshots')")
    // The committed marketplace captures can only be targeted deliberately, and
    // that path warns.
    expect(capture).toMatch(/if \(outDir === COMMITTED_DIR\) \{[\s\S]*?WARNING/)
    expect(capture).toContain("'--out'")
  })

  it('spawns an explicit executable/argv pair and never splits a string', () => {
    expect(capture).not.toMatch(/split\(' '\)/)
    expect(capture).toContain('spawnSync(browser, argv')
    for (const flag of ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=', '--window-size=', '--virtual-time-budget=', '--screenshot=']) {
      expect(capture, `flag ${flag}`).toContain(flag)
    }
  })

  it('resolves the browser in the documented order and fails loud', () => {
    const override = capture.indexOf('DSH_SHOT_CHROME')
    const cached = capture.indexOf('chromium_headless_shell-')
    const chrome = capture.indexOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(override).toBeGreaterThan(-1)
    expect(cached).toBeGreaterThan(override)
    expect(chrome).toBeGreaterThan(cached)
    expect(capture).toMatch(/no Chromium found/)
  })

  it('issues no network request', () => {
    expect(capture).not.toMatch(/fetch\(|https?:\/\//)
    expect(readFileSync(HARNESS, 'utf8')).not.toMatch(/fetch\(|XMLHttpRequest/)
  })

  it('is syntax-valid as a plain ESM module', () => {
    execFileSync(process.execPath, ['--check', CAPTURE], { stdio: 'ignore' })
  })
})

describe('published package isolation', () => {
  it('keeps assets and the screenshot tooling out of the tarball allowlist', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      readonly files: readonly string[]
      readonly scripts: Readonly<Record<string, string>>
      readonly version: string
    }
    expect(manifest.files).not.toContain('assets')
    expect(manifest.files).not.toContain('scripts/screenshots')
    expect(manifest.files.some((entry) => entry.startsWith('assets'))).toBe(false)
    expect(manifest.files.some((entry) => entry.includes('screenshots'))).toBe(false)
    // No script entry and no version change came with the screenshots.
    expect(Object.keys(manifest.scripts)).not.toContain('screenshots')
    expect(manifest.version).toBe('0.2.4')
  })
})
