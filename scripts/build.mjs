/** Build the host face with tsc, the browser face as a ModuleLoader script, and the preset patches. */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { buildClientCode } from './client-build.ts'
import { writePresetPatches } from './build-presets.mjs'

rmSync('lib', { recursive: true, force: true })
mkdirSync('lib/prompts', { recursive: true })

execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json'], { stdio: 'inherit' })

cpSync('src/prompts/endeavour.md', 'lib/prompts/endeavour.md')
cpSync('src/prompts/challenger.md', 'lib/prompts/challenger.md')

const clientCode = await buildClientCode()
writeFileSync('lib/client.js', clientCode)

const presetPatches = writePresetPatches(import.meta.dirname + '/..')

console.log(`build: host (tsc) + browser (${String(clientCode.length)} bytes ModuleLoader script) complete`)
console.log(`build: preset patches (${presetPatches.length}) written to presets/`)
