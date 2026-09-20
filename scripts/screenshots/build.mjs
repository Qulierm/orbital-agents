#!/usr/bin/env node
/**
 * Build the offline screenshot harness.
 *
 * Bundles `harness.tsx` (which imports the real client components) plus a dark
 * theme sheet into `scripts/screenshots/dist/`, so `capture.mjs` can render
 * scenes from `file://` with no network access and no running app.
 *
 * Usage:
 *   node scripts/screenshots/build.mjs
 *   node scripts/screenshots/build.mjs --theme-css /path/to/real-theme.css
 *
 * `--theme-css` substitutes a real theme stylesheet for the bundled snapshot,
 * which is useful when checking the snapshot against the app's own tokens.
 * Nothing here is part of the published package.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DIST = join(HERE, 'dist')

function themeOverride() {
  const args = process.argv.slice(2)
  const index = args.indexOf('--theme-css')
  return index >= 0 ? args[index + 1] : undefined
}

const themePath = themeOverride() ?? join(HERE, 'theme.css')
const themeCss = readFileSync(themePath, 'utf8')

mkdirSync(DIST, { recursive: true })

const result = await build({
  entryPoints: [join(HERE, 'harness.tsx')],
  outfile: join(DIST, 'harness.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  target: ['es2022'],
  logLevel: 'warning',
  // React and React DOM come from the repo's devDependencies; no new packages.
  absWorkingDir: REPO,
  define: { 'process.env.NODE_ENV': '"production"' },
})

if (result.errors.length > 0) {
  console.error(`screenshots build: ${String(result.errors.length)} error(s)`)
  process.exit(1)
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Orbital Agents screenshot harness</title>
<style>
${themeCss}
</style>
</head>
<body data-ds-dark-theme>
<div id="root" class="scene"></div>
<script src="./harness.js"></script>
</body>
</html>
`

writeFileSync(join(DIST, 'index.html'), html)
console.log(`screenshots build: theme=${themePath}`)
console.log(`screenshots build: wrote ${join(DIST, 'index.html')} and ${join(DIST, 'harness.js')}`)
