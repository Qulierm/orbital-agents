/** Build the host face with tsc and the browser face as a ModuleLoader script. */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { buildClientCode } from './client-build.ts'

rmSync('lib', { recursive: true, force: true })
mkdirSync('lib/prompts', { recursive: true })

execFileSync('node', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.host.json'], { stdio: 'inherit' })

cpSync('src/prompts/endeavour.md', 'lib/prompts/endeavour.md')
cpSync('src/prompts/challenger.md', 'lib/prompts/challenger.md')

const clientCode = await buildClientCode()
writeFileSync('lib/client.js', clientCode)

console.log(`build: host (tsc) + browser (${String(clientCode.length)} bytes ModuleLoader script) complete`)
