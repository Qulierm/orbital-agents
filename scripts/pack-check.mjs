#!/usr/bin/env node
/** Inspect the packed tarball for required files and no forbidden payloads. */

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const tarballs = readdirSync('.').filter((file) => file.endsWith('.tgz'))
if (tarballs.length === 0) throw new Error('pack-check: no .tgz found; run `pnpm pack` first')
const tarball = tarballs[0]
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean)

const required = [
  'package/package.json',
  'package/lib/index.js',
  'package/lib/client.js',
  'package/lib/prompts/endeavour.md',
  'package/lib/prompts/challenger.md',
  'package/cordis.patch.yml',
  'package/preset/endeavour.patch.yml',
  'package/preset/endeavour/agent.cordis.yml',
  'package/preset/endeavour/preset.yml',
  'package/preset/challenger/agent.cordis.yml',
  'package/preset/challenger/preset.yml',
  'package/lib/peer.js',
  'package/lib/peer-projection.js',
  'package/docs/install.md',
]
const missing = required.filter((path) => !listing.includes(path))
const forbidden = listing.filter((path) => /(^|\/)(\.env|\.git\/|node_modules\/|src\/)/.test(path))
if (missing.length > 0) throw new Error(`pack-check: missing ${missing.join(', ')}`)
if (forbidden.length > 0) throw new Error(`pack-check: forbidden payload ${forbidden.join(', ')}`)

console.log(`pack-check: ${join(process.cwd(), tarball)} contains ${String(listing.length)} entries; all required files present, no secrets/sources/node_modules`)
