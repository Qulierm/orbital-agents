#!/usr/bin/env node
/**
 * Capture the marketplace screenshots.
 *
 * Builds the harness, then renders each scene with a locally cached headless
 * Chromium and writes `assets/screenshots/<scene>.png` at 2x device scale.
 * Everything runs from `file://` against a temp-free local bundle: no network
 * request is made and no application state is touched.
 *
 * Usage:
 *   node scripts/screenshots/capture.mjs
 *   node scripts/screenshots/capture.mjs --scene plan-running
 *
 * Browser resolution order:
 *   1. `DSH_SHOT_CHROME`
 *   2. newest `~/Library/Caches/ms-playwright/chromium_headless_shell-*`
 *   3. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DIST = join(HERE, 'dist')
const OUT_DIR = join(REPO, 'assets', 'screenshots')

/** Scene → viewport. The plan card and the menu use the card width; the dock is shorter. */
const SCENES = [
  { name: 'plan-running', width: 760, height: 430 },
  { name: 'plan-interrupted', width: 760, height: 430 },
  { name: 'plan-complete', width: 760, height: 430 },
  { name: 'model-menu', width: 760, height: 430 },
  { name: 'composer-dock', width: 760, height: 240 },
]

const DEVICE_SCALE = 2
const VIRTUAL_TIME_BUDGET_MS = 4_000

/** Newest cached playwright headless shell, or undefined when none exists. */
function cachedHeadlessShell() {
  const root = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(root)) return undefined
  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'))
    .filter((path) => existsSync(path))
  return candidates[0]
}

function resolveBrowser() {
  const override = process.env.DSH_SHOT_CHROME
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      throw new Error(`screenshots capture: DSH_SHOT_CHROME points at a missing file: ${override}`)
    }
    return override
  }
  const cached = cachedHeadlessShell()
  if (cached !== undefined) return cached
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  if (existsSync(chrome)) return chrome
  throw new Error(
    'screenshots capture: no Chromium found. Set DSH_SHOT_CHROME to a chrome-headless-shell or Google Chrome binary, '
    + 'or install one under ~/Library/Caches/ms-playwright/.',
  )
}

function selectedScenes() {
  const args = process.argv.slice(2)
  const index = args.indexOf('--scene')
  if (index < 0) return SCENES
  const wanted = args[index + 1]
  const picked = SCENES.filter((scene) => scene.name === wanted)
  if (picked.length === 0) throw new Error(`screenshots capture: unknown scene ${JSON.stringify(wanted)}`)
  return picked
}

function build() {
  execFileSync(process.execPath, [join(HERE, 'build.mjs')], { stdio: 'inherit' })
}

/** Capture one scene; returns the written path. */
function capture(browser, scene) {
  const target = join(OUT_DIR, `${scene.name}.png`)
  const url = `file://${join(DIST, 'index.html')}#${scene.name}`
  // Explicit executable/argv: never a shell string split on whitespace.
  const argv = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--force-device-scale-factor=${String(DEVICE_SCALE)}`,
    `--window-size=${String(scene.width)},${String(scene.height)}`,
    `--virtual-time-budget=${String(VIRTUAL_TIME_BUDGET_MS)}`,
    `--screenshot=${target}`,
    url,
  ]
  const result = spawnSync(browser, argv, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`screenshots capture: ${scene.name} failed (exit ${String(result.status)}): ${result.stderr.trim()}`)
  }
  if (!existsSync(target)) throw new Error(`screenshots capture: ${scene.name} produced no file at ${target}`)
  return target
}

/** Validate the PNG header and report its dimensions. */
function inspect(path) {
  const buffer = readFileSync(path)
  const signature = buffer.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') throw new Error(`screenshots capture: ${path} is not a PNG`)
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  return { width, height, bytes: statSync(path).size }
}

mkdirSync(OUT_DIR, { recursive: true })
build()
const browser = resolveBrowser()
console.log(`screenshots capture: browser=${browser}`)

const report = []
for (const scene of selectedScenes()) {
  const path = capture(browser, scene)
  const info = inspect(path)
  const expectedWidth = scene.width * DEVICE_SCALE
  const expectedHeight = scene.height * DEVICE_SCALE
  if (info.width !== expectedWidth || info.height !== expectedHeight) {
    throw new Error(
      `screenshots capture: ${scene.name} is ${String(info.width)}x${String(info.height)}, expected ${String(expectedWidth)}x${String(expectedHeight)}`,
    )
  }
  if (info.bytes > 1_500_000) {
    throw new Error(`screenshots capture: ${scene.name} is ${String(info.bytes)} bytes, over the 1.5 MB cap`)
  }
  report.push({ scene: scene.name, path, ...info })
  console.log(`screenshots capture: ${scene.name} -> ${path} (${String(info.width)}x${String(info.height)}, ${String(info.bytes)} bytes)`)
}

console.log(`screenshots capture: ${String(report.length)} image(s) written to ${OUT_DIR}`)
