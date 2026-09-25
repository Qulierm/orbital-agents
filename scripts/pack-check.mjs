#!/usr/bin/env node
/** Inspect the packed tarball for required files and no forbidden payloads. */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Check the tarball of the CURRENT package version; stale tarballs of earlier
// versions must never be mistaken for this release.
const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const expected = `dsh-orbital-agents-${version}.tgz`
const tarballs = readdirSync('.').filter((file) => file.endsWith('.tgz'))
if (tarballs.length === 0) throw new Error('pack-check: no .tgz found; run `pnpm pack` first')
if (!tarballs.includes(expected)) throw new Error(`pack-check: ${expected} is missing (found: ${tarballs.join(', ')}); run \`pnpm pack\` first`)
const tarball = tarballs[0]
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean)

const required = [
  'package/scripts/schedule-desktop-restart.mjs',
  'package/package.json',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/prompts/endeavour.md',
  'package/lib/prompts/challenger.md',
  'package/cordis.patch.yml',
  'package/presets/endeavour.patch.yml',
  'package/presets/challenger.patch.yml',
  'package/lib/peer.js',
  'package/lib/peer-projection.js',
  'package/docs/install.md',
]
const missing = required.filter((path) => !listing.includes(path))
const forbidden = listing.filter((path) => /(^|\/)(\.env|\.git\/|node_modules\/|src\/)/.test(path))
if (missing.length > 0) throw new Error(`pack-check: missing ${missing.join(', ')}`)
if (forbidden.length > 0) throw new Error(`pack-check: forbidden payload ${forbidden.join(', ')}`)

console.log(`pack-check: ${join(process.cwd(), tarball)} contains ${String(listing.length)} entries; all required files present, no secrets/sources/node_modules`)
